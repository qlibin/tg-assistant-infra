import { Duration, Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import { Alarm, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { SnsAction } from "aws-cdk-lib/aws-cloudwatch-actions";
import {
  Effect,
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Key } from "aws-cdk-lib/aws-kms";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { StringParameter } from "aws-cdk-lib/aws-ssm";
import { Topic } from "aws-cdk-lib/aws-sns";

export interface SQSStackProps extends StackProps {
  environment: string;
  projectName: string;
  enableEncryption?: boolean;
  enableCostOptimization?: boolean;
  watchTowerTopicArn?: string; // reserved for future cross-stack import
  orderQueueConfig?: {
    visibilityTimeoutSeconds?: number;
    maxReceiveCount?: number;
  };
  resultQueueConfig?: {
    visibilityTimeoutSeconds?: number;
    maxReceiveCount?: number;
  };
}

export class SQSStack extends Stack {
  public readonly orderQueue: Queue;
  public readonly orderDLQ: Queue;
  public readonly resultQueue: Queue;
  public readonly resultDLQ: Queue;

  public readonly queueEncryptionKey: Key;

  public readonly webhookRole: Role;
  public readonly workerRole: Role;
  public readonly feedbackRole: Role;

  public readonly queueAlertTopic: Topic;
  public readonly orderQueueAlarms: Alarm[] = [];
  public readonly resultQueueAlarms: Alarm[] = [];

  constructor(scope: Construct, id: string, props: SQSStackProps) {
    super(scope, id, props);

    const {
      environment,
      projectName,
      enableEncryption = true,
      orderQueueConfig,
      resultQueueConfig,
    } = props;

    // KMS key for SQS queues
    this.queueEncryptionKey = new Key(this, "QueueEncryptionKey", {
      description: `${projectName}-${environment} SQS encryption key`,
      enableKeyRotation: true,
    });

    // DLQs first
    this.orderDLQ = new Queue(this, "OrderDLQ", {
      queueName: `${projectName}-${environment}-order-dlq`,
      retentionPeriod: Duration.days(7),
      ...(enableEncryption
        ? { encryptionMasterKey: this.queueEncryptionKey }
        : {}),
    });

    this.resultDLQ = new Queue(this, "ResultDLQ", {
      queueName: `${projectName}-${environment}-result-dlq`,
      retentionPeriod: Duration.days(7),
      ...(enableEncryption
        ? { encryptionMasterKey: this.queueEncryptionKey }
        : {}),
    });

    // Main queues
    const orderVisibility = Duration.seconds(
      orderQueueConfig?.visibilityTimeoutSeconds ?? 300,
    );
    const orderMaxReceive = orderQueueConfig?.maxReceiveCount ?? 3;

    this.orderQueue = new Queue(this, "OrderQueue", {
      queueName: `${projectName}-${environment}-order`,
      visibilityTimeout: orderVisibility,
      retentionPeriod: Duration.days(14),
      receiveMessageWaitTime: Duration.seconds(6),
      deadLetterQueue: {
        queue: this.orderDLQ,
        maxReceiveCount: orderMaxReceive,
      },
      ...(enableEncryption
        ? { encryptionMasterKey: this.queueEncryptionKey }
        : {}),
    });

    const resultVisibility = Duration.seconds(
      resultQueueConfig?.visibilityTimeoutSeconds ?? 180,
    );
    const resultMaxReceive = resultQueueConfig?.maxReceiveCount ?? 3;

    this.resultQueue = new Queue(this, "ResultQueue", {
      queueName: `${projectName}-${environment}-result`,
      visibilityTimeout: resultVisibility,
      retentionPeriod: Duration.days(7),
      receiveMessageWaitTime: Duration.seconds(6),
      deadLetterQueue: {
        queue: this.resultDLQ,
        maxReceiveCount: resultMaxReceive,
      },
      ...(enableEncryption
        ? { encryptionMasterKey: this.queueEncryptionKey }
        : {}),
    });

    // IAM roles
    this.webhookRole = new Role(this, "WebhookLambdaRole", {
      roleName: `${projectName}-${environment}-webhook-role`,
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole",
        ),
      ],
      inlinePolicies: {
        OrderQueueProducer: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: [
                "sqs:SendMessage",
                "sqs:GetQueueAttributes",
                "sqs:GetQueueUrl",
              ],
              resources: [this.orderQueue.queueArn],
              conditions: {
                StringEquals: { "aws:SourceAccount": this.account },
              },
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["kms:Decrypt", "kms:GenerateDataKey"],
              resources: [this.queueEncryptionKey.keyArn],
            }),
          ],
        }),
      },
    });

    this.workerRole = new Role(this, "WorkerLambdaRole", {
      roleName: `${projectName}-${environment}-worker-role`,
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole",
        ),
      ],
      inlinePolicies: {
        DualQueueWorkerAccess: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: [
                "sqs:ReceiveMessage",
                "sqs:DeleteMessage",
                "sqs:ChangeMessageVisibility",
                "sqs:GetQueueAttributes",
              ],
              resources: [this.orderQueue.queueArn],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["sqs:SendMessage", "sqs:GetQueueAttributes"],
              resources: [this.resultQueue.queueArn],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["kms:Decrypt", "kms:GenerateDataKey"],
              resources: [this.queueEncryptionKey.keyArn],
            }),
          ],
        }),
      },
    });

    this.feedbackRole = new Role(this, "FeedbackLambdaRole", {
      roleName: `${projectName}-${environment}-feedback-role`,
      assumedBy: new ServicePrincipal("lambda.amazonaws.com"),
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          "service-role/AWSLambdaBasicExecutionRole",
        ),
      ],
      inlinePolicies: {
        FeedbackDualQueueAccess: new PolicyDocument({
          statements: [
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: [
                "sqs:ReceiveMessage",
                "sqs:DeleteMessage",
                "sqs:ChangeMessageVisibility",
                "sqs:GetQueueAttributes",
              ],
              resources: [this.resultQueue.queueArn],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["sqs:SendMessage", "sqs:GetQueueAttributes"],
              resources: [this.orderQueue.queueArn],
            }),
            new PolicyStatement({
              effect: Effect.ALLOW,
              actions: ["kms:Decrypt", "kms:GenerateDataKey"],
              resources: [this.queueEncryptionKey.keyArn],
            }),
          ],
        }),
      },
    });

    // Monitoring: alarms
    const stackName = `${projectName}-${environment}`;

    const orderQueueAgeAlarm = new Alarm(this, "OrderQueueAgeAlarm", {
      alarmName: `${stackName}-order-message-age`,
      alarmDescription: "Order messages aging in queue",
      metric: this.orderQueue.metricApproximateAgeOfOldestMessage({
        period: Duration.minutes(5),
      }),
      threshold: 900,
      evaluationPeriods: 2,
    });

    const resultQueueAgeAlarm = new Alarm(this, "ResultQueueAgeAlarm", {
      alarmName: `${stackName}-result-message-age`,
      alarmDescription: "Result messages aging in queue",
      metric: this.resultQueue.metricApproximateAgeOfOldestMessage({
        period: Duration.minutes(3),
      }),
      threshold: 600,
      evaluationPeriods: 2,
    });

    const orderDLQAlarm = new Alarm(this, "OrderDLQAlarm", {
      alarmName: `${stackName}-order-dlq-messages`,
      alarmDescription: "Failed orders in Dead Letter Queue",
      metric: this.orderDLQ.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });

    const resultDLQAlarm = new Alarm(this, "ResultDLQAlarm", {
      alarmName: `${stackName}-result-dlq-messages`,
      alarmDescription: "Failed results in Dead Letter Queue",
      metric: this.resultDLQ.metricApproximateNumberOfMessagesVisible(),
      threshold: 1,
      evaluationPeriods: 1,
    });

    this.orderQueueAlarms.push(orderQueueAgeAlarm, orderDLQAlarm);
    this.resultQueueAlarms.push(resultQueueAgeAlarm, resultDLQAlarm);

    // SNS Topic and alarm actions
    this.queueAlertTopic = new Topic(this, "QueueAlertTopic", {
      topicName: `${stackName}-queue-alerts`,
      displayName: "SQS Alerts for Watch Tower",
      masterKey: this.queueEncryptionKey,
    });

    [
      orderQueueAgeAlarm,
      resultQueueAgeAlarm,
      orderDLQAlarm,
      resultDLQAlarm,
    ].forEach((alarm) => {
      alarm.addAlarmAction(new SnsAction(this.queueAlertTopic));
      alarm.addOkAction(new SnsAction(this.queueAlertTopic));
    });

    // SSM exports
    new StringParameter(this, "OrderQueueUrl", {
      parameterName: `/automation/${environment}/queues/order/url`,
      stringValue: this.orderQueue.queueUrl,
      description:
        "Order Queue URL for task distribution and requeue operations",
    });

    new StringParameter(this, "OrderQueueArn", {
      parameterName: `/automation/${environment}/queues/order/arn`,
      stringValue: this.orderQueue.queueArn,
      description: "Order Queue ARN for IAM permissions and monitoring",
    });

    new StringParameter(this, "ResultQueueUrl", {
      parameterName: `/automation/${environment}/queues/result/url`,
      stringValue: this.resultQueue.queueUrl,
      description: "Result Queue URL for processing results and feedback",
    });

    new StringParameter(this, "ResultQueueArn", {
      parameterName: `/automation/${environment}/queues/result/arn`,
      stringValue: this.resultQueue.queueArn,
      description: "Result Queue ARN for IAM permissions and monitoring",
    });

    new StringParameter(this, "QueueConfiguration", {
      parameterName: `/automation/${environment}/queues/config`,
      stringValue: JSON.stringify({
        orderQueue: {
          visibilityTimeout: orderVisibility.toSeconds(),
          maxReceiveCount: orderMaxReceive,
        },
        resultQueue: {
          visibilityTimeout: resultVisibility.toSeconds(),
          maxReceiveCount: resultMaxReceive,
        },
      }),
      description: "Queue configuration parameters for Lambda integration",
    });

    new StringParameter(this, "WebhookRoleArn", {
      parameterName: `/automation/${environment}/roles/webhook/arn`,
      stringValue: this.webhookRole.roleArn,
      description: "Webhook Lambda IAM Role ARN",
    });

    new StringParameter(this, "WorkerRoleArn", {
      parameterName: `/automation/${environment}/roles/worker/arn`,
      stringValue: this.workerRole.roleArn,
      description: "Worker Lambda IAM Role ARN",
    });

    new StringParameter(this, "FeedbackRoleArn", {
      parameterName: `/automation/${environment}/roles/feedback/arn`,
      stringValue: this.feedbackRole.roleArn,
      description: "Feedback Lambda IAM Role ARN",
    });

    new StringParameter(this, "QueueAlertTopicArn", {
      parameterName: `/automation/${environment}/monitoring/queue-alerts/topic-arn`,
      stringValue: this.queueAlertTopic.topicArn,
      description:
        "SNS Topic ARN for queue alerts integration with Watch Tower",
    });
  }
}
