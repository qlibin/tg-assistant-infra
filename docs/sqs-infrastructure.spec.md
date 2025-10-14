# SQS Infrastructure Setup Specification (Enhanced - Dual Queue Architecture)

## Overview

This task involves setting up AWS CDK infrastructure to define the core SQS messaging infrastructure for the serverless automation system. The infrastructure provides foundational messaging queues that enable asynchronous communication between different microservices in the distributed architecture with proper message filtering, security, and cost optimization using a **dual queue architecture** for better separation of concerns.

## Objectives

1. Clean up existing CDK application by removing unnecessary Lambda function
2. Define optimized dual-queue SQS architecture with Dead Letter Queues (DLQ) and message filtering capabilities
3. Configure service-specific IAM permissions with least-privilege access
4. Export queue information to AWS Systems Manager for cross-repository consumption
5. Implement comprehensive monitoring and alerting integration
6. Document secure usage patterns for integration with other system components

## Current State

- CDK application skeleton exists in `infrastructure/` directory (copied from another project)
- Contains a Lambda function that needs to be removed
- Basic CDK structure is in place but requires customization for SQS infrastructure

## Requirements

### SQS Queue Configuration

#### 1. Order Queue (Task Distribution)
- **Purpose**: Receives task orders from Webhook Lambda and distributes them to appropriate worker Lambdas via message filtering
- **Configuration**:
    - Standard SQS queue (not FIFO - supports distributed processing)
    - Visibility timeout: 300 seconds (5 minutes) - allows sufficient processing time
    - Message retention period: 14 days (maximum for investigation)
    - Receive message wait time: 6 seconds (long polling for cost optimization)
    - Dead Letter Queue attached with max receive count: 3
    - KMS encryption enabled for data at rest
    - Message deduplication via content-based deduplication ID

#### 2. Order Dead Letter Queue
- **Purpose**: Captures failed order messages for investigation and manual reprocessing
- **Configuration**:
    - Standard SQS queue with KMS encryption
    - Message retention period: 7 days for investigation and reprocessing
    - CloudWatch alarms for immediate notification on message arrival
    - No additional DLQ (terminal queue)

#### 3. Result Queue (Result Collection)
- **Purpose**: Collects processing results from all worker Lambdas for Feedback Lambda processing
- **Configuration**:
    - Standard SQS queue with KMS encryption
    - Visibility timeout: 180 seconds (3 minutes) - faster result processing
    - Message retention period: 7 days (results processed more quickly than orders)
    - Receive message wait time: 6 seconds (long polling)
    - Dead Letter Queue attached with max receive count: 3
    - Optimized for higher throughput with smaller message sizes

#### 4. Result Dead Letter Queue
- **Purpose**: Captures failed result messages that couldn't be processed
- **Configuration**:
    - Standard SQS queue with KMS encryption
    - Message retention period: 7 days
    - CloudWatch alarms for immediate notification
    - No additional DLQ (terminal queue)

### Message Filtering Strategy

Document Lambda event source filtering to route orders to appropriate workers:

### Enhanced IAM Security Model

#### Webhook Lambda Role (Order Producer Only)
```typescript
const webhookLambdaRole = new Role(this, 'WebhookLambdaRole', {
  roleName: `${projectName}-${environment}-webhook-role`,
  assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
  managedPolicies: [
    ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
  ],
  inlinePolicies: {
    'OrderQueueProducer': new PolicyDocument({
      statements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'sqs:SendMessage',
            'sqs:GetQueueAttributes',
            'sqs:GetQueueUrl'
          ],
          resources: [orderQueue.queueArn],
          conditions: {
            StringEquals: {
              'aws:SourceAccount': this.account
            }
          }
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
          resources: [queueEncryptionKey.keyArn]
        })
      ]
    })
  }
});
```

#### Worker Lambda Roles (Order Consumer + Result Producer)
```typescript
const workerLambdaRole = new Role(this, 'WorkerLambdaRole', {
  roleName: `${projectName}-${environment}-worker-role`,
  assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
  managedPolicies: [
    ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
  ],
  inlinePolicies: {
    'DualQueueWorkerAccess': new PolicyDocument({
      statements: [
        // Order Queue Consumer permissions
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'sqs:ReceiveMessage',
            'sqs:DeleteMessage',
            'sqs:ChangeMessageVisibility',
            'sqs:GetQueueAttributes'
          ],
          resources: [orderQueue.queueArn]
        }),
        // Result Queue Producer permissions  
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'sqs:SendMessage',
            'sqs:GetQueueAttributes'
          ],
          resources: [resultQueue.queueArn]
        }),
        // KMS permissions for both queues
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
          resources: [queueEncryptionKey.keyArn]
        })
      ]
    })
  }
});
```

#### Feedback Lambda Role (Result Consumer + Order Producer for Requeue)
```typescript
const feedbackLambdaRole = new Role(this, 'FeedbackLambdaRole', {
  roleName: `${projectName}-${environment}-feedback-role`,
  assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
  managedPolicies: [
    ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')
  ],
  inlinePolicies: {
    'FeedbackDualQueueAccess': new PolicyDocument({
      statements: [
        // Result Queue Consumer permissions
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'sqs:ReceiveMessage',
            'sqs:DeleteMessage',
            'sqs:ChangeMessageVisibility',
            'sqs:GetQueueAttributes'
          ],
          resources: [resultQueue.queueArn]
        }),
        // Order Queue Producer permissions (for requeue functionality)
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            'sqs:SendMessage',
            'sqs:GetQueueAttributes'
          ],
          resources: [orderQueue.queueArn]
        }),
        // KMS permissions
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
          resources: [queueEncryptionKey.keyArn]
        })
      ]
    })
  }
});
```

### Cross-Repository Integration

#### AWS Systems Manager Parameter Store Integration
Export both queue configurations for consumption by microservice repositories:

```typescript
// Order Queue Parameters
new StringParameter(this, 'OrderQueueUrl', {
  parameterName: `/automation/${environment}/queues/order/url`,
  stringValue: orderQueue.queueUrl,
  description: 'Order Queue URL for task distribution and requeue operations'
});

new StringParameter(this, 'OrderQueueArn', {
  parameterName: `/automation/${environment}/queues/order/arn`,
  stringValue: orderQueue.queueArn,
  description: 'Order Queue ARN for IAM permissions and monitoring'
});

// Result Queue Parameters
new StringParameter(this, 'ResultQueueUrl', {
  parameterName: `/automation/${environment}/queues/result/url`,
  stringValue: resultQueue.queueUrl,
  description: 'Result Queue URL for processing results and feedback'
});

new StringParameter(this, 'ResultQueueArn', {
  parameterName: `/automation/${environment}/queues/result/arn`,
  stringValue: resultQueue.queueArn,
  description: 'Result Queue ARN for IAM permissions and monitoring'
});

// Queue Configuration Parameters
new StringParameter(this, 'QueueConfiguration', {
  parameterName: `/automation/${environment}/queues/config`,
  stringValue: JSON.stringify({
    orderQueue: {
      visibilityTimeout: 300,
      maxReceiveCount: 3
    },
    resultQueue: {
      visibilityTimeout: 180,
      maxReceiveCount: 3
    }
  }),
  description: 'Queue configuration parameters for Lambda integration'
});

// IAM Role ARNs
new StringParameter(this, 'WebhookRoleArn', {
  parameterName: `/automation/${environment}/roles/webhook/arn`,
  stringValue: webhookLambdaRole.roleArn,
  description: 'Webhook Lambda IAM Role ARN'
});

new StringParameter(this, 'WorkerRoleArn', {
  parameterName: `/automation/${environment}/roles/worker/arn`,
  stringValue: workerLambdaRole.roleArn,
  description: 'Worker Lambda IAM Role ARN'
});

new StringParameter(this, 'FeedbackRoleArn', {
  parameterName: `/automation/${environment}/roles/feedback/arn`,
  stringValue: feedbackLambdaRole.roleArn,
  description: 'Feedback Lambda IAM Role ARN'
});
```

### Comprehensive Monitoring & Alerting

#### Queue-Specific CloudWatch Alarms

```typescript
// Order Queue Monitoring
const orderQueueAgeAlarm = new Alarm(this, 'OrderQueueAgeAlarm', {
  alarmName: `${stackName}-order-message-age`,
  alarmDescription: 'Order messages aging in queue',
  metric: orderQueue.metricApproximateAgeOfOldestMessage({
    period: Duration.minutes(5)
  }),
  threshold: 900, // 15 minutes max age for orders
  evaluationPeriods: 2
});

// Result Queue Monitoring  
const resultQueueAgeAlarm = new Alarm(this, 'ResultQueueAgeAlarm', {
  alarmName: `${stackName}-result-message-age`,
  alarmDescription: 'Result messages aging in queue',
  metric: resultQueue.metricApproximateAgeOfOldestMessage({
    period: Duration.minutes(3)
  }),
  threshold: 600, // 10 minutes max age for results
  evaluationPeriods: 2
});

// DLQ Monitoring (Immediate Alerts)
const orderDLQAlarm = new Alarm(this, 'OrderDLQAlarm', {
  alarmName: `${stackName}-order-dlq-messages`,
  alarmDescription: 'Failed orders in Dead Letter Queue',
  metric: orderDLQ.metricApproximateNumberOfVisibleMessages(),
  threshold: 1,
  evaluationPeriods: 1,
  treatMissingData: TreatMissingData.NOT_BREACHING
});

const resultDLQAlarm = new Alarm(this, 'ResultDLQAlarm', {
  alarmName: `${stackName}-result-dlq-messages`,
  alarmDescription: 'Failed results in Dead Letter Queue',
  metric: resultDLQ.metricApproximateNumberOfVisibleMessages(),
  threshold: 1,
  evaluationPeriods: 1
});

```

#### SNS Integration for Watch Tower
```typescript
const queueAlertTopic = new Topic(this, 'QueueAlertTopic', {
  topicName: `${stackName}-queue-alerts`,
  displayName: 'SQS Alerts for Watch Tower',
  kmsMasterKey: queueEncryptionKey
});

// Connect all alarms to SNS topic
[
  orderQueueAgeAlarm,
  resultQueueAgeAlarm,
  orderDLQAlarm,
  resultDLQAlarm
].forEach(alarm => {
  alarm.addAlarmAction(new SnsAction(queueAlertTopic));
  alarm.addOkAction(new SnsAction(queueAlertTopic));
});

// Export SNS topic for Watch Tower integration
new StringParameter(this, 'QueueAlertTopicArn', {
  parameterName: `/automation/${environment}/monitoring/queue-alerts/topic-arn`,
  stringValue: queueAlertTopic.topicArn,
  description: 'SNS Topic ARN for queue alerts integration with Watch Tower'
});
```

### Enhanced Message Schemas

#### Order Message Schema (Enhanced)
```typescript
const orderMessageSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["orderId", "taskType", "payload", "userId", "timestamp"],
  properties: {
    orderId: {
      type: "string",
      pattern: "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    },
    taskType: {
      type: "string",
      enum: [
        "playwright-scraping", "url-monitoring", "web-automation",
        "perplexity-summary", "content-analysis", "text-processing",
        "scheduled-linkedin", "scheduled-german", "system-health"
      ]
    },
    payload: {
      type: "object",
      properties: {
        url: { type: "string", format: "uri" },
        parameters: { type: "object" },
        configuration: { type: "object" },
        timeout: { type: "number", minimum: 30, maximum: 900 },
        retryPolicy: {
          type: "object",
          properties: {
            maxRetries: { type: "number", maximum: 3 },
            backoffMultiplier: { type: "number", minimum: 1.0, maximum: 5.0 }
          }
        }
      }
    },
    userId: { type: "string", minLength: 1 },
    timestamp: { type: "string", format: "date-time" },
    priority: {
      type: "string",
      enum: ["low", "normal", "high", "critical"],
      default: "normal"
    },
    retryCount: { type: "number", minimum: 0, maximum: 3 },
    deduplicationId: { type: "string", maxLength: 128 },
    correlationId: { type: "string", description: "For tracking related orders" }
  },
  additionalProperties: false
};
```

#### Result Message Schema (Enhanced)
```typescript
const resultMessageSchema = {
  $schema: "http://json-schema.org/draft-07/schema#",
  type: "object",
  required: ["orderId", "taskType", "status", "result", "processingTime", "timestamp", "userId"],
  properties: {
    orderId: { type: "string", format: "uuid" },
    correlationId: { type: "string", description: "Links to original order" },
    taskType: { type: "string" },
    status: {
      type: "string",
      enum: ["success", "failure", "partial", "timeout", "rate-limited", "cancelled"]
    },
    result: {
      type: "object",
      properties: {
        data: { type: "object" },
        summary: { type: "string", maxLength: 1000 },
        metadata: {
          type: "object",
          properties: {
            processingNode: { type: "string" },
            resourcesUsed: { type: "object" },
            errorDetails: { type: "object" },
            performanceMetrics: { type: "object" }
          }
        },
        size: { type: "number", description: "Result size in bytes", maximum: 256000 }
      }
    },
    processingTime: { type: "number", description: "Processing time in milliseconds" },
    timestamp: { type: "string", format: "date-time" },
    userId: { type: "string" },
    followUpAction: {
      type: "string",
      enum: ["notify", "requeue", "enhance", "escalate", "archive"],
      description: "Action required by Feedback Lambda"
    },
    priority: { type: "string", enum: ["low", "normal", "high", "critical"] },
    cost: { type: "number", description: "Processing cost in USD", minimum: 0 },
    queueMetrics: {
      type: "object",
      properties: {
        queueTime: { type: "number", description: "Time spent in order queue" },
        processingDelay: { type: "number", description: "Delay before processing started" }
      }
    }
  },
  additionalProperties: false
};
```

## CDK Implementation Requirements

### Stack Structure
```typescript
export interface DualQueueStackProps extends StackProps {
  environment: string;
  projectName: string;
  enableEncryption?: boolean;
  enableCostOptimization?: boolean;
  watchTowerTopicArn?: string;
  orderQueueConfig?: {
    visibilityTimeoutSeconds?: number;
    maxReceiveCount?: number;
  };
  resultQueueConfig?: {
    visibilityTimeoutSeconds?: number;
    maxReceiveCount?: number;
  };
}

export class DualQueueMessageStack extends Stack {
  // Order Queue Resources
  public readonly orderQueue: Queue;
  public readonly orderDLQ: Queue;
  
  // Result Queue Resources  
  public readonly resultQueue: Queue;
  public readonly resultDLQ: Queue;
  
  // Security
  public readonly queueEncryptionKey: Key;
  
  // IAM Roles
  public readonly webhookRole: Role;
  public readonly workerRole: Role; 
  public readonly feedbackRole: Role;
  
  // Monitoring
  public readonly queueAlertTopic: Topic;
  public readonly orderQueueAlarms: Alarm[];
  public readonly resultQueueAlarms: Alarm[];
  
  constructor(scope: Construct, id: string, props: DualQueueStackProps) {
    super(scope, id, props);
    
    // Implement dual queue architecture...
  }
}
```

## Enhanced Integration Guidelines

### Webhook Lambda Integration (Order Queue Producer)
```typescript
export class OrderQueueService {
  private sqs: SQSClient;
  private ssm: SSMClient;
  private orderQueueUrl: string;
  private queueConfig: any;
  
  async initialize() {
    // Load order queue configuration
    const [queueUrl, config] = await Promise.all([
      this.ssm.send(new GetParameterCommand({
        Name: `/automation/${process.env.ENVIRONMENT}/queues/order/url`
      })),
      this.ssm.send(new GetParameterCommand({
        Name: `/automation/${process.env.ENVIRONMENT}/queues/config`
      }))
    ]);
    
    this.orderQueueUrl = queueUrl.Parameter!.Value!;
    this.queueConfig = JSON.parse(config.Parameter!.Value!);
  }
  
  async sendOrder(order: OrderMessage): Promise<void> {
    const command = new SendMessageCommand({
      QueueUrl: this.orderQueueUrl,
      MessageBody: JSON.stringify(order),
      MessageAttributes: {
        TaskType: { DataType: "String", StringValue: order.taskType },
        Priority: { DataType: "String", StringValue: order.priority },
        UserId: { DataType: "String", StringValue: order.userId },
        CorrelationId: { DataType: "String", StringValue: order.correlationId || order.orderId }
      },
      MessageDeduplicationId: order.deduplicationId
    });
    
    const result = await this.sqs.send(command);
    console.log(`Order sent to Order Queue: ${result.MessageId}`);
  }
}
```

### Worker Lambda Integration (Order Consumer + Result Producer)
```typescript
export class DualQueueWorkerService {
  private sqs: SQSClient;
  private resultQueueUrl: string;
  
  async initialize() {
    const parameter = await new SSMClient({}).send(new GetParameterCommand({
      Name: `/automation/${process.env.ENVIRONMENT}/queues/result/url`
    }));
    this.resultQueueUrl = parameter.Parameter!.Value!;
    this.sqs = new SQSClient({ region: process.env.AWS_REGION });
  }
  
  async sendResult(result: ResultMessage): Promise<void> {
    const command = new SendMessageCommand({
      QueueUrl: this.resultQueueUrl,
      MessageBody: JSON.stringify(result),
      MessageAttributes: {
        Status: { DataType: "String", StringValue: result.status },
        Priority: { DataType: "String", StringValue: result.priority },
        FollowUpAction: { DataType: "String", StringValue: result.followUpAction },
        TaskType: { DataType: "String", StringValue: result.taskType }
      }
    });
    
    const sendResult = await this.sqs.send(command);
    console.log(`Result sent to Result Queue: ${sendResult.MessageId}`);
  }
}

// SQS Handler for Order Processing
export const handler: SQSHandler = async (event, context) => {
  const batchItemFailures: { itemIdentifier: string }[] = [];
  const workerService = new DualQueueWorkerService();
  await workerService.initialize();
  
  for (const record of event.Records) {
    try {
      const order: OrderMessage = JSON.parse(record.body);
      const startTime = Date.now();
      
      // Process order based on task type
      const processResult = await processOrderByType(order);
      const processingTime = Date.now() - startTime;
      
      // Send result to Result Queue
      await workerService.sendResult({
        orderId: order.orderId,
        correlationId: order.correlationId,
        taskType: order.taskType,
        status: processResult.success ? 'success' : 'failure',
        result: processResult,
        processingTime,
        timestamp: new Date().toISOString(),
        userId: order.userId,
        followUpAction: determineFollowUpAction(processResult),
        priority: order.priority
      });
      
    } catch (error) {
      console.error(`Failed to process order ${record.messageId}:`, error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  
  return { batchItemFailures };
};
```

### Feedback Lambda Integration (Result Consumer + Order Producer for Requeue)
```typescript
export class FeedbackService {
  private orderQueueService: OrderQueueService;
  private telegramService: TelegramService;
  private perplexityService: PerplexityService;
  
  async initialize() {
    this.orderQueueService = new OrderQueueService();
    await this.orderQueueService.initialize();
    
    this.telegramService = new TelegramService();
    this.perplexityService = new PerplexityService();
  }
  
  async processResult(result: ResultMessage): Promise<void> {
    switch (result.followUpAction) {
      case 'notify':
        await this.telegramService.sendNotification(result.userId, result);
        break;
        
      case 'enhance':
        const enhancedResult = await this.perplexityService.enhanceResult(result);
        await this.telegramService.sendNotification(result.userId, enhancedResult);
        break;
        
      case 'requeue':
        const retryOrder = this.createRetryOrder(result);
        await this.orderQueueService.sendOrder(retryOrder);
        break;
        
      case 'escalate':
        await this.handleEscalation(result);
        break;
        
      case 'archive':
        await this.archiveResult(result);
        break;
    }
  }
}

// SQS Handler for Result Processing
export const handler: SQSHandler = async (event, context) => {
  const feedbackService = new FeedbackService();
  await feedbackService.initialize();
  
  const batchItemFailures: { itemIdentifier: string }[] = [];
  
  for (const record of event.Records) {
    try {
      const result: ResultMessage = JSON.parse(record.body);
      await feedbackService.processResult(result);
    } catch (error) {
      console.error(`Failed to process result ${record.messageId}:`, error);
      batchItemFailures.push({ itemIdentifier: record.messageId });
    }
  }
  
  return { batchItemFailures };
};
```

## Implementation Tasks

### Phase 1: Clean Up & Foundation
- [ ] Remove existing Lambda function definition and related resources
- [ ] Remove unused imports and dependencies
- [ ] Update stack name and description for dual queue SQS infrastructure
- [ ] Set up KMS encryption key with proper rotation policy

### Phase 2: Dual Queue Infrastructure
- [ ] Create KMS encryption key for both queues
- [ ] Create Order DLQ and Result DLQ (dependencies first)
- [ ] Create Order Queue with optimized configuration for task distribution
- [ ] Create Result Queue with optimized configuration for result processing
- [ ] Configure queue-specific properties and cost optimization settings
- [ ] Add comprehensive resource tags for cost allocation

### Phase 3: Security & IAM (Queue-Specific)
- [ ] Create service-specific IAM policies with resource-level permissions for each queue
- [ ] Create Webhook Lambda role (Order Queue producer only)
- [ ] Create Worker Lambda role (Order consumer + Result producer)
- [ ] Create Feedback Lambda role (Result consumer + Order producer for requeue)
- [ ] Implement cross-account access patterns

### Phase 4: Integration docs
- [ ] Document Integration Guidelines for Webhook Lambda, worker Lambda, and feedback Lambda
- [ ] Define and document task-type filtering patterns for Order Queue consumers
- [ ] Define and document result-type filtering patterns for Result Queue consumers

### Phase 5: Comprehensive Monitoring
- [ ] Create SNS topic for alerts
- [ ] Implement Order Queue specific alarm for age
- [ ] Implement Result Queue specific alarm for age
- [ ] Add DLQ monitoring with immediate alerts for both queues
- [ ] Create cost monitoring alarms for unusual activity patterns

### Phase 6: Cross-Repository Integration
- [ ] Export both queue URLs and ARNs to Systems Manager Parameter Store
- [ ] Export queue-specific configuration parameters
- [ ] Export all IAM role ARNs for cross-service integration
- [ ] Export monitoring and alerting topic information for Watch Tower

### Phase 7: Testing & Validation
- [ ] Test Order Queue message filtering with different task types
- [ ] Test Result Queue message filtering with different follow-up actions
- [ ] Validate cross-queue workflow (Order → Processing → Result → Feedback)
- [ ] Test DLQ functionality with intentional failures on both queues
- [ ] Performance test both queues with high message volumes
- [ ] Validate requeue functionality from Result processing back to Order queue
- [ ] Implement a snapshot test

## Success Criteria

1. ✅ Clean CDK stack with dual queue SQS architecture and security configurations
2. ✅ Four SQS queues with KMS encryption and queue-specific monitoring
3. ✅ Message filtering implemented for efficient task and result routing
4. ✅ Service-specific IAM roles with resource-level permissions for each queue
5. ✅ Systems Manager Parameter Store integration for cross-repository access
6. ✅ Queue-specific CloudWatch alarms integrated with Watch Tower monitoring
7. ✅ Optimized message schemas with validation and correlation tracking
8. ✅ Cost optimization features enabled (different batch sizes, polling configurations)
9. ✅ Cross-queue workflow validation (Order → Processing → Result → Feedback → Requeue)
10. ✅ Successfully deployable to multiple environments with proper queue isolation
11. ✅ Comprehensive documentation and integration examples for dual queue pattern
