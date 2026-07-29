import { InstanceClass, InstanceSize, InstanceType } from 'aws-cdk-lib/aws-ec2';

/**
 * Per-environment sizing and naming. Select with `cdk deploy -c env=dev`.
 *
 * Anything secret (JWT signing key, Stripe keys, SMTP credentials) is
 * deliberately absent — those live in Secrets Manager and are referenced by ARN
 * at deploy time, never checked in.
 */
export interface DomainConfig {
  /** Route 53 hosted zone that owns the names below, e.g. `parentix.ca`. */
  zoneName: string;
  /** Family App, e.g. `app.parentix.ca`. */
  appDomain: string;
  /** Admin Dashboard, e.g. `admin.parentix.ca`. */
  adminDomain: string;
  /** API/ALB, e.g. `api.parentix.ca`. */
  apiDomain: string;
  /**
   * ACM certificate in us-east-1 covering appDomain + adminDomain.
   * CloudFront only accepts certificates from that region.
   */
  cloudFrontCertificateArn: string;
  /** ACM certificate in the deployment region covering apiDomain, for the ALB. */
  albCertificateArn: string;
}

export interface ParentixConfig {
  envName: string;
  region: string;
  /** Optional — falls back to the ambient CDK account. */
  account?: string;

  /**
   * Leave undefined to deploy without custom domains. Everything still works
   * over the generated CloudFront and ALB hostnames; TLS on the ALB and the
   * `/api` CloudFront behaviour fall back to HTTP to the origin.
   */
  domain?: DomainConfig;

  /** Absolute URL of the Family App, used in password-reset emails. */
  appUrl: string;
  /** Absolute URL of the Admin Dashboard. */
  adminUrl: string;

  network: {
    maxAzs: number;
    /** One NAT gateway is cheaper; two removes a single point of failure. */
    natGateways: number;
  };

  api: {
    cpu: number;
    memoryLimitMiB: number;
    desiredCount: number;
    minCapacity: number;
    maxCapacity: number;
  };

  database: {
    instanceType: InstanceType;
    allocatedStorageGb: number;
    maxAllocatedStorageGb: number;
    multiAz: boolean;
    backupRetentionDays: number;
    deletionProtection: boolean;
  };

  redis: {
    /** Required once the API runs more than one task. */
    enabled: boolean;
    nodeType: string;
  };

  email: {
    /** Must be a verified SES identity (domain or address). */
    fromAddress: string;
    /** Receives contact-form messages and new-registration notices. */
    adminAddress: string;
  };

  /** Retain data stores on stack deletion — always true for production. */
  retainDataOnDelete: boolean;
}

/**
 * Where contact-form submissions and new-registration notices are sent.
 *
 * These messages carry other people's personal data — a visitor's name, email
 * and message; a new parent's name and email. A shared, controlled role mailbox
 * on the company domain is the right destination for that once real users are
 * signing up; a personal consumer mailbox is fine for getting started but has no
 * access controls, no retention policy, and no way to hand over.
 *
 * Overridable so it can be changed without a code change or a new commit:
 *   PARENTIX_ADMIN_EMAIL=ops@parentix.ca npm run infra:deploy
 */
const adminEmail = process.env.PARENTIX_ADMIN_EMAIL || 'merhawigu@gmail.com';

const dev: ParentixConfig = {
  envName: 'dev',
  region: 'us-east-2',
  appUrl: 'http://localhost:3000',
  adminUrl: 'http://localhost:3001',
  network: { maxAzs: 2, natGateways: 1 },
  api: { cpu: 512, memoryLimitMiB: 1024, desiredCount: 1, minCapacity: 1, maxCapacity: 2 },
  database: {
    instanceType: InstanceType.of(InstanceClass.BURSTABLE4_GRAVITON, InstanceSize.MICRO),
    allocatedStorageGb: 20,
    maxAllocatedStorageGb: 50,
    multiAz: false,
    backupRetentionDays: 1,
    deletionProtection: false,
  },
  redis: { enabled: false, nodeType: 'cache.t4g.micro' },
  email: { fromAddress: 'Parentix <no-reply@parentix.ca>', adminAddress: adminEmail },
  retainDataOnDelete: false,
};

const prod: ParentixConfig = {
  envName: 'prod',
  region: 'us-east-2',
  appUrl: 'https://app.parentix.ca',
  adminUrl: 'https://admin.parentix.ca',
  // Fill this in and redeploy once the hosted zone and certificates exist.
  // domain: {
  //   zoneName: 'parentix.ca',
  //   appDomain: 'app.parentix.ca',
  //   adminDomain: 'admin.parentix.ca',
  //   apiDomain: 'api.parentix.ca',
  //   cloudFrontCertificateArn: 'arn:aws:acm:us-east-1:<account>:certificate/<id>',
  //   albCertificateArn: 'arn:aws:acm:us-east-2:<account>:certificate/<id>',
  // },
  network: { maxAzs: 2, natGateways: 2 },
  api: { cpu: 1024, memoryLimitMiB: 2048, desiredCount: 2, minCapacity: 2, maxCapacity: 6 },
  database: {
    instanceType: InstanceType.of(InstanceClass.BURSTABLE4_GRAVITON, InstanceSize.SMALL),
    allocatedStorageGb: 50,
    maxAllocatedStorageGb: 200,
    multiAz: true,
    backupRetentionDays: 14,
    deletionProtection: true,
  },
  // More than one API task means Socket.IO events must cross tasks.
  redis: { enabled: true, nodeType: 'cache.t4g.micro' },
  email: { fromAddress: 'Parentix <no-reply@parentix.ca>', adminAddress: adminEmail },
  retainDataOnDelete: true,
};

const CONFIGS: Record<string, ParentixConfig> = { dev, prod };

export const getConfig = (envName: string): ParentixConfig => {
  const config = CONFIGS[envName];
  if (!config) {
    throw new Error(`Unknown environment "${envName}". Known: ${Object.keys(CONFIGS).join(', ')}`);
  }
  return config;
};
