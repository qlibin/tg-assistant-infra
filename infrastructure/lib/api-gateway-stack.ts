import { Duration, Stack, StackProps, Arn } from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  RestApi,
  LambdaIntegration,
  EndpointType,
  MethodLoggingLevel,
  DomainName,
  IDomainName,
  BasePathMapping,
  SecurityPolicy,
} from "aws-cdk-lib/aws-apigateway";
import { Function as LambdaFunction } from "aws-cdk-lib/aws-lambda";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  ARecord,
  RecordTarget,
  HostedZone,
  IHostedZone,
} from "aws-cdk-lib/aws-route53";
import { ApiGatewayDomain } from "aws-cdk-lib/aws-route53-targets";
import { Alarm, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { Topic } from "aws-cdk-lib/aws-sns";
import { StringParameter } from "aws-cdk-lib/aws-ssm";

export interface ApiGatewayStackProps extends StackProps {
  environment: string;
  projectName: string;
  lambdaFunctionName: string;
  certificateArn: string;
  hostedZoneId: string;
  hostedZoneName: string;
  domainName: string;
  basePath: string;
  throttling?:
    | {
        rateLimit?: number;
        burstLimit?: number;
      }
    | undefined;
  /**
   * If provided, import existing custom domain instead of creating a new one.
   * This is the regional domain name (e.g., d-xxx.execute-api.region.amazonaws.com)
   */
  existingDomainRegionalDomainName?: string | undefined;
  /**
   * Regional hosted zone ID for the existing custom domain.
   * Required if existingDomainRegionalDomainName is provided.
   */
  existingDomainRegionalHostedZoneId?: string | undefined;
  /**
   * Whether to create a new DNS record. Set to false if the record already exists.
   * Default: true
   */
  createDnsRecord?: boolean | undefined;
}

export class ApiGatewayStack extends Stack {
  public readonly restApi: RestApi;
  public readonly customDomain: IDomainName;
  public readonly dnsRecord?: ARecord;
  public readonly apiAlertTopic: Topic;
  public readonly apiAlarms: Alarm[] = [];

  constructor(scope: Construct, id: string, props: ApiGatewayStackProps) {
    super(scope, id, props);

    const {
      environment,
      projectName,
      lambdaFunctionName,
      certificateArn,
      hostedZoneId,
      hostedZoneName,
      domainName,
      basePath,
      throttling,
      existingDomainRegionalDomainName,
      existingDomainRegionalHostedZoneId,
      createDnsRecord = true,
    } = props;

    const stackName = `${projectName}-${environment}`;
    const rateLimit = throttling?.rateLimit ?? 10;
    const burstLimit = throttling?.burstLimit ?? 25;

    // Import the existing Lambda function by name
    const lambdaFunction = LambdaFunction.fromFunctionName(
      this,
      "WebhookLambda",
      lambdaFunctionName,
    );

    // Create REST API with regional endpoint
    this.restApi = new RestApi(this, "RestApi", {
      restApiName: `${projectName}-telegram-bot-api-${environment}`,
      description: `Telegram bot API Gateway for ${environment}`,
      endpointConfiguration: {
        types: [EndpointType.REGIONAL],
      },
      disableExecuteApiEndpoint: true,
      deployOptions: {
        stageName: environment,
        throttlingRateLimit: rateLimit,
        throttlingBurstLimit: burstLimit,
        loggingLevel: MethodLoggingLevel.INFO,
        dataTraceEnabled: false,
        metricsEnabled: true,
      },
    });

    // Create the webhook listener resource and POST method
    const listenerResource = this.restApi.root.addResource(
      "qlibin-assistant-listener",
    );

    const lambdaIntegration = new LambdaIntegration(lambdaFunction, {
      proxy: true,
      timeout: Duration.seconds(29),
    });

    listenerResource.addMethod("POST", lambdaIntegration);

    // Custom domain: import existing or create new
    if (
      existingDomainRegionalDomainName &&
      existingDomainRegionalHostedZoneId
    ) {
      // Import existing custom domain (created manually or by another stack)
      this.customDomain = DomainName.fromDomainNameAttributes(
        this,
        "CustomDomain",
        {
          domainName: domainName,
          domainNameAliasTarget: existingDomainRegionalDomainName,
          domainNameAliasHostedZoneId: existingDomainRegionalHostedZoneId,
        },
      );
    } else {
      // Create new custom domain
      const certificate = Certificate.fromCertificateArn(
        this,
        "Certificate",
        certificateArn,
      );

      this.customDomain = new DomainName(this, "CustomDomain", {
        domainName: domainName,
        certificate: certificate,
        endpointType: EndpointType.REGIONAL,
        securityPolicy: SecurityPolicy.TLS_1_2,
      });
    }

    // Base path mapping
    new BasePathMapping(this, "BasePathMapping", {
      domainName: this.customDomain,
      restApi: this.restApi,
      basePath: basePath,
      stage: this.restApi.deploymentStage,
    });

    // DNS record: only create if requested and domain was created (not imported)
    if (createDnsRecord && !existingDomainRegionalDomainName) {
      const hostedZone: IHostedZone = HostedZone.fromHostedZoneAttributes(
        this,
        "HostedZone",
        {
          hostedZoneId: hostedZoneId,
          zoneName: hostedZoneName,
        },
      );

      this.dnsRecord = new ARecord(this, "ApiAliasRecord", {
        zone: hostedZone,
        recordName: domainName,
        target: RecordTarget.fromAlias(
          new ApiGatewayDomain(this.customDomain as DomainName),
        ),
      });
    }

    // SNS Topic for API Gateway alerts
    this.apiAlertTopic = new Topic(this, "ApiAlertTopic", {
      topicName: `${stackName}-api-alerts`,
      displayName: "API Gateway Alerts",
    });

    // CloudWatch Alarms
    const error5xxAlarm = new Alarm(this, "Api5XXErrorAlarm", {
      alarmName: `${stackName}-api-5xx-errors`,
      alarmDescription: "API Gateway 5XX errors detected",
      metric: this.restApi.metricServerError({
        period: Duration.minutes(5),
        statistic: "Sum",
      }),
      threshold: 5,
      evaluationPeriods: 2,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    const latencyAlarm = new Alarm(this, "ApiLatencyAlarm", {
      alarmName: `${stackName}-api-latency`,
      alarmDescription: "API Gateway latency exceeds threshold",
      metric: this.restApi.metricLatency({
        period: Duration.minutes(5),
        statistic: "p95",
      }),
      threshold: 5000,
      evaluationPeriods: 3,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    this.apiAlarms.push(error5xxAlarm, latencyAlarm);

    // Wire alarms to SNS
    [error5xxAlarm, latencyAlarm].forEach((alarm) => {
      alarm.addAlarmAction(new SnsAction(this.apiAlertTopic));
      alarm.addOkAction(new SnsAction(this.apiAlertTopic));
    });

    // Build API Gateway source ARN for Lambda permissions
    const sourceArn = Arn.format(
      {
        service: "execute-api",
        resource: this.restApi.restApiId,
        resourceName: "*",
      },
      this,
    );

    // SSM Parameter exports
    new StringParameter(this, "RestApiId", {
      parameterName: `/automation/${environment}/api-gateway/rest-api-id`,
      stringValue: this.restApi.restApiId,
      description: "REST API ID for API Gateway",
    });

    new StringParameter(this, "RestApiUrl", {
      parameterName: `/automation/${environment}/api-gateway/rest-api-url`,
      stringValue: this.restApi.url,
      description: "REST API URL (execute-api endpoint)",
    });

    new StringParameter(this, "DomainNameParam", {
      parameterName: `/automation/${environment}/api-gateway/domain-name`,
      stringValue: domainName,
      description: "Custom domain name for API Gateway",
    });

    new StringParameter(this, "StageName", {
      parameterName: `/automation/${environment}/api-gateway/stage-name`,
      stringValue: environment,
      description: "API Gateway stage name",
    });

    new StringParameter(this, "SourceArn", {
      parameterName: `/automation/${environment}/api-gateway/source-arn`,
      stringValue: sourceArn,
      description:
        "API Gateway source ARN for Lambda resource-based permissions",
    });
  }
}
