import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
import { ParentixConfig } from './config';

interface WebStackProps extends StackProps {
  config: ParentixConfig;
  /**
   * Bucket names rather than Bucket objects: the origins are built from
   * *imported* buckets so CDK does not try to attach a generated policy to a
   * bucket owned by another stack. That policy is written in the storage stack
   * instead — see the OAC statement there.
   */
  familyAppBucketName: string;
  adminAppBucketName: string;
  uploadsBucketName: string;
  loadBalancer: elbv2.IApplicationLoadBalancer;
}

/**
 * One CloudFront distribution per web app.
 *
 * Each distribution also fronts the API, so `/api/*` and `/socket.io/*` are
 * same-origin for the browser. That removes CORS preflights from the hot path
 * and means the apps never need to know the ALB hostname.
 */
export class WebStack extends Stack {
  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);

    const { config, loadBalancer } = props;

    const importBucket = (id_: string, bucketName: string) =>
      s3.Bucket.fromBucketAttributes(this, id_, { bucketName, region: this.region });

    const familyAppBucket = importBucket('FamilyAppBucket', props.familyAppBucketName);
    const adminAppBucket = importBucket('AdminAppBucket', props.adminAppBucketName);
    const uploadsBucket = importBucket('UploadsBucket', props.uploadsBucketName);

    const certificate = config.domain
      ? acm.Certificate.fromCertificateArn(this, 'CloudFrontCertificate', config.domain.cloudFrontCertificateArn)
      : undefined;

    // ── API origin ────────────────────────────────────────────────────────────
    // With a certificate on the ALB, CloudFront reaches it over HTTPS by name.
    // Without one there is no certificate to validate, so the hop is HTTP —
    // acceptable only for a domain-less dev deployment.
    const apiOrigin = new origins.LoadBalancerV2Origin(loadBalancer, {
      protocolPolicy: config.domain
        ? cloudfront.OriginProtocolPolicy.HTTPS_ONLY
        : cloudfront.OriginProtocolPolicy.HTTP_ONLY,
      readTimeout: Duration.seconds(60),
      keepaliveTimeout: Duration.seconds(60),
      customHeaders: config.domain ? {} : undefined,
    });

    /**
     * The API is dynamic and authenticated: cache nothing, and forward every
     * header, cookie and query string so auth and WebSocket upgrades survive.
     */
    const apiBehavior: cloudfront.BehaviorOptions = {
      origin: apiOrigin,
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
      cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
      originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER,
      compress: true,
    };

    // ── URL rewriting ─────────────────────────────────────────────────────────
    // `/` and `/contact` map to the static marketing pages; anything else
    // without a file extension is a client-side route and must load index.html.
    const familyRewrite = new cloudfront.Function(this, 'FamilyRewrite', {
      comment: 'Marketing pages at / and /contact; SPA fallback elsewhere',
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var uri = request.uri;

  if (uri === '/' || uri === '') {
    request.uri = '/landing.html';
  } else if (uri === '/contact' || uri === '/contact/') {
    request.uri = '/contact.html';
  } else if (!uri.startsWith('/media/') && !uri.includes('.')) {
    request.uri = '/index.html';
  }

  return request;
}
      `),
    });

    const adminRewrite = new cloudfront.Function(this, 'AdminRewrite', {
      comment: 'SPA fallback for the admin console',
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  if (!request.uri.includes('.')) {
    request.uri = '/index.html';
  }
  return request;
}
      `),
    });

    // Uploaded objects live under their own key prefixes, so the /media prefix
    // used by the public URL has to come off before the S3 lookup.
    const mediaRewrite = new cloudfront.Function(this, 'MediaRewrite', {
      comment: 'Strip the /media prefix before reading from the uploads bucket',
      code: cloudfront.FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  request.uri = request.uri.replace(/^\\/media/, '');
  return request;
}
      `),
    });

    const staticBehavior = (fn: cloudfront.Function) => ({
      viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
      cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
      compress: true,
      functionAssociations: [{ function: fn, eventType: cloudfront.FunctionEventType.VIEWER_REQUEST }],
    });

    // ── Family App ────────────────────────────────────────────────────────────
    const familyDistribution = new cloudfront.Distribution(this, 'FamilyDistribution', {
      comment: `Parentix Family App (${config.envName})`,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(familyAppBucket),
        ...staticBehavior(familyRewrite),
      },
      additionalBehaviors: {
        '/api/*': apiBehavior,
        '/socket.io/*': apiBehavior,
        '/media/*': {
          origin: origins.S3BucketOrigin.withOriginAccessControl(uploadsBucket),
          ...staticBehavior(mediaRewrite),
        },
      },
      domainNames: config.domain ? [config.domain.appDomain] : undefined,
      certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // The rewrite function already resolves client-side routes; these cover a
      // genuinely missing object without leaking an S3 error page.
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
      ],
    });

    // ── Admin Dashboard ───────────────────────────────────────────────────────
    const adminDistribution = new cloudfront.Distribution(this, 'AdminDistribution', {
      comment: `Parentix Admin Dashboard (${config.envName})`,
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(adminAppBucket),
        ...staticBehavior(adminRewrite),
      },
      additionalBehaviors: {
        '/api/*': apiBehavior,
        '/socket.io/*': apiBehavior,
      },
      domainNames: config.domain ? [config.domain.adminDomain] : undefined,
      certificate,
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.minutes(5) },
      ],
    });

    new CfnOutput(this, 'FamilyAppUrl', {
      value: config.domain ? `https://${config.domain.appDomain}` : `https://${familyDistribution.distributionDomainName}`,
    });
    new CfnOutput(this, 'FamilyDistributionId', { value: familyDistribution.distributionId });
    new CfnOutput(this, 'AdminAppUrl', {
      value: config.domain ? `https://${config.domain.adminDomain}` : `https://${adminDistribution.distributionDomainName}`,
    });
    new CfnOutput(this, 'AdminDistributionId', { value: adminDistribution.distributionId });
  }
}
