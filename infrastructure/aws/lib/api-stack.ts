import { Stack, StackProps, Duration, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as ecsPatterns from 'aws-cdk-lib/aws-ecs-patterns';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { ParentixConfig } from './config';

interface ApiStackProps extends StackProps {
  config: ParentixConfig;
  vpc: ec2.Vpc;
  database: rds.DatabaseInstance;
  databaseSecret: secretsmanager.ISecret;
  appSecret: secretsmanager.ISecret;
  uploadsBucket: s3.Bucket;
  redisEndpoint?: string;
}

/**
 * The API: an ECR repository, a Fargate service behind an Application Load
 * Balancer, and the IAM the tasks need to reach SES, S3 and Secrets Manager.
 */
export class ApiStack extends Stack {
  public readonly loadBalancer: elbv2.IApplicationLoadBalancer;
  public readonly repository: ecr.Repository;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const { config, vpc, databaseSecret, appSecret, uploadsBucket, redisEndpoint } = props;

    // ── Image registry ────────────────────────────────────────────────────────
    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: `parentix-api-${config.envName}`,
      imageScanOnPush: true,
      removalPolicy: RemovalPolicy.RETAIN,
      lifecycleRules: [{ maxImageCount: 20, description: 'Keep the 20 most recent images' }],
    });

    // The image tag to run. CI passes the commit SHA:
    //   cdk deploy -c imageTag=$GITHUB_SHA
    const imageTag = (this.node.tryGetContext('imageTag') as string) || 'latest';

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      clusterName: `parentix-${config.envName}`,
      containerInsights: true,
    });

    const logGroup = new logs.LogGroup(this, 'ApiLogs', {
      logGroupName: `/parentix/${config.envName}/api`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const certificate = config.domain
      ? acm.Certificate.fromCertificateArn(this, 'AlbCertificate', config.domain.albCertificateArn)
      : undefined;

    // ── Service ───────────────────────────────────────────────────────────────
    const service = new ecsPatterns.ApplicationLoadBalancedFargateService(this, 'Service', {
      cluster,
      serviceName: `parentix-api-${config.envName}`,
      cpu: config.api.cpu,
      memoryLimitMiB: config.api.memoryLimitMiB,
      desiredCount: config.api.desiredCount,
      publicLoadBalancer: true,
      // Tasks stay in private subnets and reach the internet via NAT.
      taskSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      assignPublicIp: false,
      certificate,
      redirectHTTP: !!certificate,
      protocol: certificate ? elbv2.ApplicationProtocol.HTTPS : elbv2.ApplicationProtocol.HTTP,
      domainName: config.domain?.apiDomain,
      // Roll back automatically if the new task set never goes healthy.
      circuitBreaker: { rollback: true },
      // Keep full capacity during a deploy: start replacements before retiring
      // the tasks they replace, rather than dipping to half the desired count.
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
      taskImageOptions: {
        image: ecs.ContainerImage.fromEcrRepository(this.repository, imageTag),
        containerPort: 5000,
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: 'api', logGroup }),
        environment: {
          NODE_ENV: 'production',
          PORT: '5000',
          LOG_LEVEL: 'info',
          TRUST_PROXY: '1',
          AWS_REGION: config.region,

          CLIENT_URL: config.appUrl,
          ADMIN_URL: config.adminUrl,

          DB_SSL: 'true',
          DB_NAME: 'parentix',
          DB_POOL_MAX: '10',

          REDIS_URL: redisEndpoint || '',

          EMAIL_PROVIDER: 'ses',
          EMAIL_FROM: config.email.fromAddress,
          ADMIN_EMAIL: config.email.adminAddress,

          STORAGE_PROVIDER: 's3',
          S3_BUCKET: uploadsBucket.bucketName,
          // Uploaded images are served through the Family App distribution so
          // the bucket itself never needs to be public.
          S3_PUBLIC_BASE_URL: `${config.appUrl}/media`,
        },
        secrets: {
          // The RDS-managed secret is the only source of database credentials.
          DB_HOST: ecs.Secret.fromSecretsManager(databaseSecret, 'host'),
          DB_PORT: ecs.Secret.fromSecretsManager(databaseSecret, 'port'),
          DB_USER: ecs.Secret.fromSecretsManager(databaseSecret, 'username'),
          DB_PASSWORD: ecs.Secret.fromSecretsManager(databaseSecret, 'password'),

          JWT_SECRET: ecs.Secret.fromSecretsManager(appSecret, 'JWT_SECRET'),
          FIELD_ENCRYPTION_KEY: ecs.Secret.fromSecretsManager(appSecret, 'FIELD_ENCRYPTION_KEY'),
          STRIPE_SECRET_KEY: ecs.Secret.fromSecretsManager(appSecret, 'STRIPE_SECRET_KEY'),
          STRIPE_WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(appSecret, 'STRIPE_WEBHOOK_SECRET'),
          STRIPE_PREMIUM_PRICE_ID: ecs.Secret.fromSecretsManager(appSecret, 'STRIPE_PREMIUM_PRICE_ID'),
          STRIPE_FAMILY_PRICE_ID: ecs.Secret.fromSecretsManager(appSecret, 'STRIPE_FAMILY_PRICE_ID'),
        },
      },
    });

    this.loadBalancer = service.loadBalancer;

    // ── Health checks ─────────────────────────────────────────────────────────
    service.targetGroup.configureHealthCheck({
      path: '/api/health',
      healthyHttpCodes: '200',
      interval: Duration.seconds(30),
      timeout: Duration.seconds(5),
      healthyThresholdCount: 2,
      unhealthyThresholdCount: 3,
    });

    // Socket.IO connections are long-lived; the default 5 minute idle timeout
    // would cut them, and draining needs long enough for a clean shutdown.
    service.targetGroup.setAttribute('deregistration_delay.timeout_seconds', '30');
    service.loadBalancer.setAttribute('idle_timeout.timeout_seconds', '300');

    // Sticky sessions keep a Socket.IO client on one task across its HTTP
    // long-polling handshake, which is what the client falls back to.
    service.targetGroup.enableCookieStickiness(Duration.hours(1));

    // ── Autoscaling ───────────────────────────────────────────────────────────
    const scaling = service.service.autoScaleTaskCount({
      minCapacity: config.api.minCapacity,
      maxCapacity: config.api.maxCapacity,
    });

    scaling.scaleOnCpuUtilization('CpuScaling', {
      targetUtilizationPercent: 65,
      scaleInCooldown: Duration.minutes(3),
      scaleOutCooldown: Duration.minutes(1),
    });

    scaling.scaleOnMemoryUtilization('MemoryScaling', {
      targetUtilizationPercent: 75,
      scaleInCooldown: Duration.minutes(3),
      scaleOutCooldown: Duration.minutes(1),
    });

    // ── Task permissions ──────────────────────────────────────────────────────
    const taskRole = service.taskDefinition.taskRole;

    // Read and write only under this bucket — pre-signed URLs are signed with
    // these credentials, so the grant bounds what any URL can ever do.
    uploadsBucket.grantReadWrite(taskRole);

    taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ses:SendEmail', 'ses:SendRawEmail'],
        resources: ['*'],
        conditions: {
          // Only from the verified sending identity.
          StringEquals: { 'ses:FromAddress': extractAddress(config.email.fromAddress) },
        },
      })
    );

    new CfnOutput(this, 'ApiUrl', {
      value: `${certificate ? 'https' : 'http'}://${config.domain?.apiDomain ?? service.loadBalancer.loadBalancerDnsName}`,
      description: 'Direct API endpoint (the child app talks to this)',
    });
    new CfnOutput(this, 'LoadBalancerDns', { value: service.loadBalancer.loadBalancerDnsName });
    new CfnOutput(this, 'EcrRepositoryUri', { value: this.repository.repositoryUri });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'ServiceName', { value: service.service.serviceName });
  }
}

/** `Parentix <no-reply@parentix.ca>` → `no-reply@parentix.ca` */
const extractAddress = (from: string): string => {
  const match = from.match(/<([^>]+)>/);
  return match ? match[1] : from;
};
