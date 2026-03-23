import { Duration, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import {
  HttpApi,
  HttpStage,
  DomainName,
  IDomainName,
  ApiMapping,
  LogGroupLogDestination,
} from "aws-cdk-lib/aws-apigatewayv2";
import { Certificate } from "aws-cdk-lib/aws-certificatemanager";
import {
  ARecord,
  RecordTarget,
  HostedZone,
  IHostedZone,
} from "aws-cdk-lib/aws-route53";
import { ApiGatewayv2DomainProperties } from "aws-cdk-lib/aws-route53-targets";
import { Alarm, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import { Topic } from "aws-cdk-lib/aws-sns";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { LogGroup, RetentionDays } from "aws-cdk-lib/aws-logs";
import { AccessLogFormat } from "aws-cdk-lib/aws-apigateway";

export interface ApiGatewayStackProps extends StackProps {
  environment: string;
  projectName: string;
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
  public readonly httpApi: HttpApi;
  public readonly customDomain: IDomainName;
  public readonly dnsRecord?: ARecord;
  public readonly apiAlertTopic: Topic;
  public readonly apiAlarms: Alarm[] = [];

  constructor(scope: Construct, id: string, props: ApiGatewayStackProps) {
    super(scope, id, props);

    const {
      environment,
      projectName,
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

    // Create HTTP API (v2) with no default stage
    // Consumer projects attach their own routes via SSM-exported identifiers
    this.httpApi = new HttpApi(this, "HttpApi", {
      apiName: `${projectName}-telegram-bot-api-${environment}`,
      description: `Telegram bot API Gateway for ${environment}`,
      createDefaultStage: false,
      disableExecuteApiEndpoint: true,
    });

    // Access log group for the stage
    const accessLogGroup = new LogGroup(this, "ApiAccessLogGroup", {
      logGroupName: `/aws/apigateway/${stackName}-http-api`,
      retention: RetentionDays.ONE_MONTH,
    });

    // Create explicit stage with throttling, metrics, and access logging
    const stage = new HttpStage(this, "HttpStage", {
      httpApi: this.httpApi,
      stageName: environment,
      autoDeploy: true,
      throttle: {
        rateLimit,
        burstLimit,
      },
      detailedMetricsEnabled: true,
      accessLogSettings: {
        destination: new LogGroupLogDestination(accessLogGroup),
        format: AccessLogFormat.custom(
          JSON.stringify({
            requestId: "$context.requestId",
            ip: "$context.identity.sourceIp",
            requestTime: "$context.requestTime",
            httpMethod: "$context.httpMethod",
            routeKey: "$context.routeKey",
            status: "$context.status",
            protocol: "$context.protocol",
            responseLength: "$context.responseLength",
            integrationError: "$context.integrationErrorMessage",
            errorMessage: "$context.error.message",
          }),
        ),
      },
    });

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
          name: domainName,
          regionalDomainName: existingDomainRegionalDomainName,
          regionalHostedZoneId: existingDomainRegionalHostedZoneId,
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
      });
    }

    // API mapping (replaces BasePathMapping)
    new ApiMapping(this, "ApiMapping", {
      api: this.httpApi,
      domainName: this.customDomain,
      stage: stage,
      apiMappingKey: basePath,
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
          new ApiGatewayv2DomainProperties(
            this.customDomain.regionalDomainName,
            this.customDomain.regionalHostedZoneId,
          ),
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
      metric: this.httpApi.metricServerError({
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
      metric: this.httpApi.metricLatency({
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

    // SSM Parameter exports
    new StringParameter(this, "ApiId", {
      parameterName: `/automation/${environment}/api-gateway/id`,
      stringValue: this.httpApi.apiId,
      description: "HTTP API ID for API Gateway",
    });

    new StringParameter(this, "ApiUrl", {
      parameterName: `/automation/${environment}/api-gateway/url`,
      stringValue: stage.url,
      description: "HTTP API URL (execute-api endpoint)",
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
  }
}
