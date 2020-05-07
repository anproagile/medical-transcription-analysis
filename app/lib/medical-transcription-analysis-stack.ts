import * as cdk from '@aws-cdk/core';
import iam = require("@aws-cdk/aws-iam");
import cloudfront = require("@aws-cdk/aws-cloudfront");
import s3deploy = require ("@aws-cdk/aws-s3-deployment");
import apigateway = require("@aws-cdk/aws-apigateway");
import lambda = require("@aws-cdk/aws-lambda");

import {
  CloudFrontWebDistribution,
  OriginAccessIdentity,
  PriceClass,
  HttpVersion,
} from "@aws-cdk/aws-cloudfront";
import {
  CfnUserPoolUser,
  UserPoolClient,
  UserPool,
  CfnIdentityPool,
  CfnIdentityPoolRoleAttachment,
} from "@aws-cdk/aws-cognito";
import { CanonicalUserPrincipal } from "@aws-cdk/aws-iam";
import s3 = require("@aws-cdk/aws-s3");
import { BucketEncryption } from "@aws-cdk/aws-s3";
import uuid = require("short-uuid");
import { requireProperty } from '@aws-cdk/core';
require("dotenv").config();
export interface MTAStackProps {
  email: string;
}

export class MedicalTranscriptionAnalysisStack extends cdk.Stack {
  uuid: string;
  resourceName: (name: any) => string;
  constructor(
    scope: cdk.Construct, 
    id: string, 
    props: MTAStackProps
    ) {
    super(scope, id);


  this.resourceName = (name: any) =>
    `${id}-${name}`.toLowerCase();

  this.uuid = uuid.generate();

  const corsRule = {
    allowedOrigins: ["*"],
    allowedMethods: [
      s3.HttpMethods.HEAD,
      s3.HttpMethods.GET,
      s3.HttpMethods.PUT,
      s3.HttpMethods.POST,
      s3.HttpMethods.DELETE
    ],
    maxAge: 3000,
    exposedHeaders: ["ETag"],
    allowedHeaders: ["*"]
  };
        // ### Client ###

        const webAppS3Bucket = new s3.Bucket(
          this,
          this.resourceName("webAppS3Bucket"),
          {
            websiteIndexDocument: "index.html",
            cors: [corsRule],
            blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
            encryption: BucketEncryption.S3_MANAGED
          }
        );
         
        const oai = new OriginAccessIdentity(
          this,
          "mta-oai",
          {
              comment:
                "Origin Access Identity for Medical Transcription Analysis web stack bucket cloudfront distribution"
            
          }
        );
    
        const distribution = new CloudFrontWebDistribution(
          this,
          "mta-cfront",
          {
            originConfigs: [
              {
                behaviors: [{ isDefaultBehavior: true }],
                s3OriginSource: {
                  s3BucketSource: webAppS3Bucket,
                  originAccessIdentity: oai,
                },
              }
            ],
            priceClass: PriceClass.PRICE_CLASS_100,
            httpVersion: HttpVersion.HTTP2,
            enableIpV6: true,
            defaultRootObject: "index.html"
          }
        );
    
        const cloudfrontPolicyStatement = new iam.PolicyStatement({
          actions: ["s3:GetBucket*", "s3:GetObject*", "s3:List*"],
          resources: [
            webAppS3Bucket.bucketArn,
            `${webAppS3Bucket.bucketArn}/*`
          ],
          principals: [new CanonicalUserPrincipal(oai.cloudFrontOriginAccessIdentityS3CanonicalUserId)]
        });

        webAppS3Bucket.addToResourcePolicy(cloudfrontPolicyStatement);
   
    
    // ####### Cognito User Authentication #######

    const mtaUserPool = new UserPool(this, "mta-user-pool", {
      userPoolName: "mta-user-pool",
      autoVerify: { email: true },
        passwordPolicy: {
          minLength: 8,
          requireUppercase: true,
          requireDigits: true,
          requireSymbols: true
        },
        userInvitation: {
          emailSubject: "Your MTA login",
          emailBody: `<p>You are invited to try the Medical Transcription Analysis Solution. Your credentials are:</p> \
                <p> \
                Username: <strong>{username}</strong><br /> \
                Password: <strong>{####}</strong> \
                </p> \
                <p> \
                Please sign in with the user name and your temporary password provided above at: <br /> \
                https://${distribution.domainName} \
                </p>`
        
      }
    });

        // Depends upon all other parts of the stack having been created.
        const mtaUserPoolUser = new CfnUserPoolUser(
          this,
          "mta-user-pool-user",
          {
            desiredDeliveryMediums: ["EMAIL"],
            forceAliasCreation: false,
            userPoolId: mtaUserPool.userPoolId,
            userAttributes: [
              {
                name: "email",
                value: props.email
              }
            ],
            username: props.email.replace(/@/, ".")
          }
        );

        const mtaUserPoolClient = new UserPoolClient(
          this,
          "mta-user-pool-client",
          {
            userPoolClientName: "mta_app",
            userPool: mtaUserPool
          }
        );
        const mtaIdentityPool = new CfnIdentityPool(
          this,
          "mta-identity-pool",
          {
            identityPoolName: "mtaUserIdentityPool",
            allowUnauthenticatedIdentities: true,
            cognitoIdentityProviders: [
              {
                clientId: mtaUserPoolClient.userPoolClientId,
                providerName: mtaUserPool.userPoolProviderName,
                serverSideTokenCheck: false
              }
            ]
          }
        );

        const cognitoPolicy = new iam.Policy(this, "mta-cognito-policy", {
          statements: [
            new iam.PolicyStatement({
              actions: ["cognito-identity:GetId"],
              resources: [
                  "*"
               ],
              effect: iam.Effect.ALLOW
            }),
            new iam.PolicyStatement({
              actions: ["transcribe:*", "comprehendmedical:*"],
              resources: [
                "*"
              ],
              effect: iam.Effect.ALLOW
            })
          ]
        });
    
        const cognitoPolicyResource = cognitoPolicy.node.findChild(
          "Resource"
        ) as iam.CfnPolicy;
        cognitoPolicyResource.cfnOptions.metadata = {
          cfn_nag: {
            rules_to_suppress: [
              {
                id: "W11",
                reason:
                  "The resources in the policy are created/managed by this solution."
              }
            ]
          }
        };

        const mtaCognitoAuthenticatedRole = new iam.Role(
          this,
          "mta-cognito-authenticated-role",
          {
            assumedBy: new iam.FederatedPrincipal(
              "cognito-identity.amazonaws.com",
              {
                StringEquals: {
                  "cognito-identity.amazonaws.com:aud": mtaIdentityPool.ref
                },
                "ForAnyValue:StringLike": {
                  "cognito-identity.amazonaws.com:amr": "authenticated"
                }
              },
              "sts:AssumeRoleWithWebIdentity"
            ),
            path: "/"
          }
        );
    
        cognitoPolicy.attachToRole(mtaCognitoAuthenticatedRole);
    
        const mtaIdentityPoolRoleAttachment = new CfnIdentityPoolRoleAttachment(
          this,
          "mta-identity-role-pool-attachment",
          {
            identityPoolId: mtaIdentityPool.ref,
            roles: {
              authenticated: mtaCognitoAuthenticatedRole.roleArn
            }
          }
        );

        const yarnBotoLoc = lambda.Code.fromAsset("lambda/boto3");

        const boto3Layer = new lambda.LayerVersion(
          this,
          this.resourceName("Boto3"),
          {
            code: yarnBotoLoc,
            compatibleRuntimes: [lambda.Runtime.PYTHON_3_7],
            license: "Apache-2.0"
          }
        );

        const transcriberRole = new iam.Role(
          this,
          this.resourceName("TranscriberRole"),
          {
            assumedBy: new iam.ServicePrincipal("iam.amazonaws.com")
          }
        );

        transcriberRole.assumeRolePolicy?.addStatements(new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ["sts:AssumeRole"],
          principals: [new iam.AccountRootPrincipal]
        }));
        
        transcriberRole.addToPolicy(
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            resources: ["*"],
            actions: ["transcribe:StartStreamTranscriptionWebSocket","transcribe:StartMedicalStreamTranscription","comprehendmedical:InferICD10CM","comprehendmedical:InferRxNorm","comprehendmedical:DetectEntitiesV2"]
          })
        );

        // Lambda
        const apiProcessor = new lambda.Function(
          this,
          this.resourceName("MTAApiProcessor"),
          {
            runtime: lambda.Runtime.PYTHON_3_7,
            code: lambda.Code.asset("lambda"),
            handler: "lambda_function.lambda_handler",
            timeout: cdk.Duration.seconds(60),
            environment: {
              TRANSCRIBE_ACCESS_ROLEARN: transcriberRole.roleArn,
              REGION: process.env.region
            }
          }
        );

        apiProcessor.addToRolePolicy(
          new iam.PolicyStatement({
            actions: ["sts:AssumeRole"],
            effect: iam.Effect.ALLOW,
            resources: [transcriberRole.roleArn]
          })
        );

        apiProcessor.addLayers(boto3Layer);

        const api = new apigateway.LambdaRestApi(
          this,
          this.resourceName("MTADemoAPI"),
          {
            handler: apiProcessor,
            proxy: false,
            deployOptions: {
              loggingLevel: apigateway.MethodLoggingLevel.INFO,
              dataTraceEnabled: true
            }
          }
        );
    
        const reqValidator = new apigateway.RequestValidator(
          this,
          this.resourceName("apigwResourceValidator"),
          {
            restApi: api,
            validateRequestBody: true,
            validateRequestParameters: true
          }
        );
    
        const authorizer = new apigateway.CfnAuthorizer(this, "Authorizer", {
          identitySource: "method.request.header.Authorization",
          name: "Authorization",
          type: "COGNITO_USER_POOLS",
          providerArns: [mtaUserPool.userPoolArn],
          restApiId: api.restApiId
        });
    
        function addCorsOptionsAndMethods(
          apiResource: apigateway.IResource | apigateway.Resource,
          methods: string[] | []
        ) {
          const options = apiResource.addMethod(
            "OPTIONS",
            new apigateway.MockIntegration({
              integrationResponses: [
                {
                  statusCode: "200",
                  responseParameters: {
                    "method.response.header.Access-Control-Allow-Headers":
                      "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token,X-Amz-User-Agent'",
                    "method.response.header.Access-Control-Allow-Origin": "'*'",
                    "method.response.header.Access-Control-Allow-Credentials":
                      "'false'",
                    "method.response.header.Access-Control-Allow-Methods":
                      "'OPTIONS,GET,PUT,POST,DELETE'"
                  }
                }
              ],
              passthroughBehavior: apigateway.PassthroughBehavior.NEVER,
              requestTemplates: {
                "application/json": '{"statusCode": 200}'
              }
            }),
            {
              methodResponses: [
                {
                  statusCode: "200",
                  responseParameters: {
                    "method.response.header.Access-Control-Allow-Headers": true,
                    "method.response.header.Access-Control-Allow-Methods": true,
                    "method.response.header.Access-Control-Allow-Credentials": true,
                    "method.response.header.Access-Control-Allow-Origin": true
                  }
                }
              ],
              requestValidator: reqValidator
            }
          );
    
          methods.forEach(method => {
            apiResource.addMethod(method, undefined, {
              authorizationType: apigateway.AuthorizationType.COGNITO,
              authorizer: {
                authorizerId: `${authorizer.ref}`
              }
            });
          });
        }
    
        addCorsOptionsAndMethods(api.root, []);
    
        const searchResource = api.root.addResource("getCredentials");
        addCorsOptionsAndMethods(searchResource, ["GET", "POST"]);
    
        cognitoPolicy.addStatements(
          new iam.PolicyStatement({
            actions: ["execute-api:Invoke"],
            resources: [api.arnForExecuteApi()],
            effect: iam.Effect.ALLOW
          })
        );
  }
  
}
