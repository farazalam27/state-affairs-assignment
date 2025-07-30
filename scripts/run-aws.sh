#!/bin/bash

# Michigan Legislature Hearing Processor - AWS Cloud Version
# This script runs the entire pipeline using AWS services for scalability:
# - S3 for video storage with accelerated transfer
# - ECS/Batch for parallel processing
# - RDS for PostgreSQL database
# - Lambda for event-driven transcription

set -e  # Exit on error

echo "🚀 Michigan Legislature Hearing Processor - AWS Edition"
echo "======================================================="

# Check if .env exists
if [ ! -f .env ]; then
    echo "❌ Error: .env file not found!"
    echo "Please copy .env.example to .env and configure it:"
    echo "  cp .env.example .env"
    exit 1
fi

# Load environment variables
set -a
source .env
set +a

# Check AWS credentials
if [ -z "$AWS_ACCESS_KEY_ID" ] || [ -z "$AWS_SECRET_ACCESS_KEY" ]; then
    echo "❌ Error: AWS credentials not found!"
    echo "Please set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY in your .env file"
    echo "Or configure AWS CLI with: aws configure"
    exit 1
fi

# Check required AWS configuration
if [ -z "$AWS_S3_BUCKET" ]; then
    echo "❌ Error: AWS_S3_BUCKET not set in .env"
    echo "Please create an S3 bucket and set AWS_S3_BUCKET=your-bucket-name"
    exit 1
fi

if [ -z "$AWS_REGION" ]; then
    export AWS_REGION="us-east-1"
    echo "ℹ️  Using default region: $AWS_REGION"
fi

echo "✅ AWS credentials configured"
echo "   Region: $AWS_REGION"
echo "   S3 Bucket: $AWS_S3_BUCKET"
echo ""

# Step 1: Check/Create AWS Infrastructure
echo "🏗️  Checking AWS infrastructure..."

# Check if S3 bucket exists
if aws s3 ls "s3://$AWS_S3_BUCKET" 2>&1 | grep -q 'NoSuchBucket'; then
    echo "Creating S3 bucket: $AWS_S3_BUCKET"
    aws s3 mb "s3://$AWS_S3_BUCKET" --region "$AWS_REGION"
    
    # Enable transfer acceleration for faster uploads
    aws s3api put-bucket-accelerate-configuration \
        --bucket "$AWS_S3_BUCKET" \
        --accelerate-configuration Status=Enabled
fi

echo "✅ S3 bucket ready with transfer acceleration"
echo ""

# Step 2: Deploy RDS PostgreSQL if needed
if [ "$AWS_USE_RDS" = "true" ]; then
    echo "📦 Setting up RDS PostgreSQL..."
    
    # Check if RDS instance exists
    if ! aws rds describe-db-instances --db-instance-identifier michigan-hearings 2>/dev/null; then
        echo "Creating RDS instance..."
        aws rds create-db-instance \
            --db-instance-identifier michigan-hearings \
            --db-instance-class db.t3.micro \
            --engine postgres \
            --engine-version 15 \
            --allocated-storage 20 \
            --master-username michigan_user \
            --master-user-password "$DB_PASSWORD" \
            --vpc-security-group-ids "$AWS_SECURITY_GROUP" \
            --backup-retention-period 7 \
            --no-publicly-accessible
        
        echo "⏳ Waiting for RDS instance to be available (this may take 5-10 minutes)..."
        aws rds wait db-instance-available --db-instance-identifier michigan-hearings
    fi
    
    # Get RDS endpoint
    export RDS_ENDPOINT=$(aws rds describe-db-instances \
        --db-instance-identifier michigan-hearings \
        --query 'DBInstances[0].Endpoint.Address' \
        --output text)
    
    export DATABASE_URL="postgresql://michigan_user:$DB_PASSWORD@$RDS_ENDPOINT:5432/michigan_hearings"
    echo "✅ RDS PostgreSQL ready at: $RDS_ENDPOINT"
else
    echo "ℹ️  Using local PostgreSQL database"
    docker-compose up -d postgres
fi

echo ""

# Step 3: Deploy Lambda function for transcription
echo "🔧 Deploying Lambda transcription function..."

# Package Lambda function
cd scripts
zip -r ../lambda-transcriber.zip parallel_processor.py

# Create Lambda function if it doesn't exist
if ! aws lambda get-function --function-name michigan-transcriber 2>/dev/null; then
    aws lambda create-function \
        --function-name michigan-transcriber \
        --runtime python3.11 \
        --role "$AWS_LAMBDA_ROLE_ARN" \
        --handler parallel_processor.lambda_handler \
        --zip-file fileb://../lambda-transcriber.zip \
        --timeout 900 \
        --memory-size 3008 \
        --environment Variables="{DATABASE_URL=$DATABASE_URL,AWS_S3_BUCKET=$AWS_S3_BUCKET}"
else
    # Update existing function
    aws lambda update-function-code \
        --function-name michigan-transcriber \
        --zip-file fileb://../lambda-transcriber.zip
fi

cd ..
rm lambda-transcriber.zip

echo "✅ Lambda function deployed"
echo ""

# Step 4: Set up S3 event trigger for automatic transcription
echo "🔗 Setting up S3 event triggers..."

# Create S3 event notification configuration
cat > s3-notification.json <<EOF
{
    "LambdaFunctionConfigurations": [
        {
            "LambdaFunctionArn": "arn:aws:lambda:$AWS_REGION:$AWS_ACCOUNT_ID:function:michigan-transcriber",
            "Events": ["s3:ObjectCreated:*"],
            "Filter": {
                "Key": {
                    "FilterRules": [
                        {
                            "Name": "prefix",
                            "Value": "videos/"
                        },
                        {
                            "Name": "suffix",
                            "Value": ".mp4"
                        }
                    ]
                }
            }
        }
    ]
}
EOF

aws s3api put-bucket-notification-configuration \
    --bucket "$AWS_S3_BUCKET" \
    --notification-configuration file://s3-notification.json

rm s3-notification.json

echo "✅ S3 triggers configured - videos will auto-transcribe when uploaded"
echo ""

# Step 5: Run the scraper with S3 upload
echo "🔍 Running scraper with S3 upload enabled..."

# Set environment for S3 uploads
export VIDEO_STORAGE_PATH="s3://$AWS_S3_BUCKET/videos"
export TRANSCRIPTION_STORAGE_PATH="s3://$AWS_S3_BUCKET/transcriptions"
export USE_S3_ACCELERATION=true

# Build TypeScript if needed
if [ ! -d "dist" ] || [ "src" -nt "dist" ]; then
    echo "🔨 Building TypeScript..."
    npm run build
fi

# Run the scraper
echo "Starting scraper..."
echo "   Max videos: ${MAX_HEARINGS_PER_RUN:-3}"
echo "   S3 bucket: $AWS_S3_BUCKET"
echo ""

RUN_ONCE=true node dist/index.js

echo ""

# Step 6: Monitor processing
echo "📊 Monitoring AWS processing..."
echo ""

# Show Lambda invocations
echo "Recent Lambda invocations:"
aws logs tail /aws/lambda/michigan-transcriber --since 5m || echo "No recent logs"

echo ""

# Show S3 contents
echo "Videos in S3:"
aws s3 ls "s3://$AWS_S3_BUCKET/videos/" --human-readable

echo ""
echo "Transcriptions in S3:"
aws s3 ls "s3://$AWS_S3_BUCKET/transcriptions/" --human-readable

echo ""
echo "✅ AWS processing pipeline is running!"
echo ""
echo "💡 Tips:"
echo "   - Videos are automatically transcribed when uploaded to S3"
echo "   - Monitor Lambda logs: aws logs tail /aws/lambda/michigan-transcriber --follow"
echo "   - View CloudWatch metrics: aws cloudwatch get-metric-statistics ..."
echo "   - Download transcriptions: aws s3 sync s3://$AWS_S3_BUCKET/transcriptions ./transcriptions"
echo ""
echo "📈 Cost Estimate:"
echo "   - S3 Storage: ~$0.023/GB/month"
echo "   - Lambda: ~$0.0000166667/GB-second"
echo "   - Data Transfer: ~$0.09/GB (accelerated)"
echo "   - RDS: ~$15/month (db.t3.micro)"