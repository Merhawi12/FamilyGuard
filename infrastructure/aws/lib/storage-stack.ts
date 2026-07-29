import { Stack, StackProps, RemovalPolicy, Duration, CfnOutput } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { ParentixConfig } from './config';

interface StorageStackProps extends StackProps {
  config: ParentixConfig;
}

/**
 * The three buckets, kept in their own stack so neither the API nor the web
 * distributions depend on each other's deployment order.
 *
 * Every bucket blocks public access; CloudFront reads them through an Origin
 * Access Control, and uploads arrive via short-lived pre-signed PUT URLs.
 */
export class StorageStack extends Stack {
  public readonly familyAppBucket: s3.Bucket;
  public readonly adminAppBucket: s3.Bucket;
  public readonly uploadsBucket: s3.Bucket;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    const { config } = props;
    const removalPolicy = config.retainDataOnDelete ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY;

    const siteBucket = (id_: string) =>
      new s3.Bucket(this, id_, {
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        encryption: s3.BucketEncryption.S3_MANAGED,
        enforceSSL: true,
        // Site content is rebuilt from source on every deploy, so it is safe to
        // clear even in production.
        removalPolicy: RemovalPolicy.DESTROY,
        autoDeleteObjects: true,
      });

    this.familyAppBucket = siteBucket('FamilyAppBucket');
    this.adminAppBucket = siteBucket('AdminAppBucket');

    this.uploadsBucket = new s3.Bucket(this, 'UploadsBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: config.retainDataOnDelete,
      removalPolicy,
      autoDeleteObjects: !config.retainDataOnDelete,
      cors: [
        {
          // Browsers PUT directly to S3 using a pre-signed URL, which is a
          // cross-origin request from the web apps.
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.GET, s3.HttpMethods.HEAD],
          allowedOrigins: [config.appUrl, config.adminUrl],
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
      lifecycleRules: [
        {
          // A pre-signed URL that was never used leaves a partial upload behind.
          abortIncompleteMultipartUploadAfter: Duration.days(3),
        },
      ],
    });

    /**
     * Read access for CloudFront's Origin Access Control.
     *
     * The policy is written here rather than being generated from the
     * distribution, because the web stack already depends on this one and the
     * generated policy would point back at it — a cycle CloudFormation cannot
     * deploy. Scoping to `AWS:SourceAccount` means only distributions in this
     * account can read, which is the boundary that matters: the buckets stay
     * closed to the public either way.
     */
    [this.familyAppBucket, this.adminAppBucket, this.uploadsBucket].forEach((bucket) => {
      bucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowCloudFrontOriginAccessControl',
          actions: ['s3:GetObject'],
          resources: [bucket.arnForObjects('*')],
          principals: [new iam.ServicePrincipal('cloudfront.amazonaws.com')],
          conditions: { StringEquals: { 'AWS:SourceAccount': this.account } },
        })
      );
    });

    new CfnOutput(this, 'FamilyAppBucketName', { value: this.familyAppBucket.bucketName });
    new CfnOutput(this, 'AdminAppBucketName', { value: this.adminAppBucket.bucketName });
    new CfnOutput(this, 'UploadsBucketName', { value: this.uploadsBucket.bucketName });
  }
}
