#!/bin/bash
set -e

# TODO 
# Creer un script cloud build a la place
# les source seront telechargé depuis github ou un bucket (a voir)
# ca doit etre un "one liner"
# style: gcloud builds submit --config=https://github.com/username/repository/blob/branch/cloudbuild.yaml
# TODO REMOVE
#gcloud config set project host-437615

# COLORS
RED="31"
GREEN="32"
BOLDWHITE="\e[1;37m"
LIGHTBLUE="\e[94m"
LIGHTYELLOW="\e[93m"
BOLDBLUE="\e[1;94m"
BOLDGREEN="\e[1;${GREEN}m"
ITALGREEN="\e[3;${GREEN}m"
ITALICRED="\e[3;${RED}m"
ENDCOLOR="\e[0m"

# FUNCTIONS

# Create a bucket with the name (with increment) provided. If already exists return the existing one.
# If already exist in another account add an increment to find a free name.
create_bucket () {
    NAME=$1
    INCREMENT=0
    BUCKET=""
    while [ -z "$BUCKET" ];
    do
        BUCKET_NAME="${NAME}-${HOST_SHORT_ID}-${INCREMENT}"
        BUCKET=$(gcloud storage buckets list --filter="name=${BUCKET_NAME}" --format="value(name)")
        if [ -z "$BUCKET" ]; then
            gcloud storage buckets create "gs://${BUCKET_NAME}" --user-output-enabled=false --verbosity=$VERBOSITY || true
            BUCKET=$(gcloud storage buckets list --filter="name=${BUCKET_NAME}" --format="value(name)")
        fi
        INCREMENT=$((INCREMENT+1))
    done
    echo $BUCKET
}

PROJECT_ID=$(gcloud config get-value project)
LOCATION=europe-west1
VERBOSITY=none

printf "${LIGHTYELLOW}##########################################################${ENDCOLOR}\n"
printf "${LIGHTYELLOW}#                                                        #${ENDCOLOR}\n"
printf "${LIGHTYELLOW}#                   GCP HOST INSTALLER                   #${ENDCOLOR}\n"
printf "${LIGHTYELLOW}#                                                        #${ENDCOLOR}\n"
printf "${LIGHTYELLOW}##########################################################${ENDCOLOR}\n"
printf "\n"

printf "\n"
printf "${BOLDBLUE}* Google Cloud Platform (GCP) project:${ENDCOLOR}\n"
printf "\n"
printf ". GCP project Id: ${ITALGREEN}${PROJECT_ID}${ENDCOLOR}\n"
printf ". Location: ${ITALGREEN}${LOCATION}${ENDCOLOR}\n"
printf "\n"


PAIRING_SECRET_KEY=$1

ORGANIZATION=default
HOST_NAME=my-first-host
HOST_ID=$(echo "@$ORGANIZATION/$HOST_NAME")
HOST_VERSION="1.0.0"
HOST_SHORT_ID=$(echo -n "$HOST_ID" | openssl dgst -sha256 | cut -d' ' -f2 | cut -c1-6)
CURRENT_TIMESTAMP=$(($(date +%s)*1000 + $(date +%N | cut -b1-3)))


# create the firestore database use to store hosts informations (it is idempotent)
HOSTS_DATABASE_NAME="hosts"
printf "\n"
printf "${BOLDBLUE}* Hosts Database:${ENDCOLOR}\n"
printf "\n"
if (gcloud firestore databases describe --database="${HOSTS_DATABASE_NAME}" --format=none --verbosity=$VERBOSITY); then
    printf "Using existing database: ${ITALGREEN}${HOSTS_DATABASE_NAME}${ENDCOLOR}\n"
else
    printf "Creating new database...\n"
    gcloud firestore databases create --database="${HOSTS_DATABASE_NAME}" --location="${LOCATION}" --format=none --verbosity=$VERBOSITY
    printf "Database created: ${BOLDGREEN}${HOSTS_DATABASE_NAME}${ENDCOLOR}\n"
fi
printf "\n"


printf "\n"
printf "${BOLDBLUE}* Updating Host informations:${ENDCOLOR}\n"
printf "\n"
printf ". Host Id: ${ITALGREEN}${HOST_ID}${ENDCOLOR}\n"
printf ". Host Short Id: ${ITALGREEN}${HOST_SHORT_ID}${ENDCOLOR}\n"
printf ". Host Version: ${ITALGREEN}${HOST_VERSION}${ENDCOLOR}\n"
printf ". UpdatedAt: ${ITALGREEN}${CURRENT_TIMESTAMP}${ENDCOLOR}\n"
printf "\n"

# Check no collision in the short_id
FIRESTORE_URL="https://firestore.googleapis.com/v1/projects/$PROJECT_ID/databases/$HOSTS_DATABASE_NAME/documents/hosts/$HOST_SHORT_ID"
FIELD_NAME="hostId"

RESPONSE=$(gcloud auth print-access-token | curl -s -w "%{http_code}" -o response.json -H "Authorization: Bearer $(cat -)" "$FIRESTORE_URL")
HTTP_CODE_GET="${RESPONSE: -3}"
DOCUMENT=$(cat response.json)

if [ "$HTTP_CODE_GET" -eq 200 ] || [ "$HTTP_CODE_GET" -eq 201 ]; then
    SUBSTR="\"$HOST_ID\""
    if [[ "$DOCUMENT" != *"$SUBSTR"* ]]; then
        echo "The '$FIELD_NAME' does not exist, is empty or does not match with $HOST_ID"
        exit 1
    fi
fi

if [ "$HTTP_CODE_GET" -eq 200 ] || [ "$HTTP_CODE_GET" -eq 201 ] || [ "$HTTP_CODE_GET" -eq 404 ]; then

    JSON_BODY="{\"fields\": {\"hostId\": {\"stringValue\": \"$HOST_ID\"}, \"hostShortId\": {\"stringValue\": \"$HOST_SHORT_ID\"}, \"hostVersion\": {\"stringValue\": \"$HOST_VERSION\"}, \"updatedAt\": {\"doubleValue\": \"$CURRENT_TIMESTAMP\"}}}"

    HTTP_CODE_PATCH=$(gcloud auth print-access-token | curl -s -w "%{http_code}" -o response.json -X PATCH "$FIRESTORE_URL" \
        -H "Authorization: Bearer $(cat -)" \
        -H "Content-Type: application/json" \
        --data-raw "$JSON_BODY")

    if [ "$HTTP_CODE_PATCH" -eq 200 ] || [ "$HTTP_CODE_PATCH" -eq 201 ]; then
        echo "The host information was successfully updated."
    else
        echo "Failed to update the host information. HTTP code: $HTTP_CODE_PATCH"
        exit 1
    fi

fi


#TS=$(date +%s)

# enable needed gcp services
printf "\n"
printf "${BOLDBLUE}* Enabling GCP services:${ENDCOLOR}\n"
printf "\n"
printf ". cloudbuild.googleapis.com              \n"
printf ". compute.googleapis.com                 \n"
printf ". apigateway.googleapis.com              \n"
printf ". servicecontrol.googleapis.com          \n"
printf ". eventarc.googleapis.com                \n"
printf ". eventarcpublishing.googleapis.com      \n"
printf ". appengine.googleapis.com               \n"
printf ". firestore.googleapis.com               \n"
printf ". iam.googleapis.com                     \n"
printf ". cloudfunctions.googleapis.com          \n"
printf ". workflows.googleapis.com               \n"
printf ". cloudresourcemanager.googleapis.com    \n"
printf ". run.googleapis.com                     \n"
printf ". artifactregistry.googleapis.com        \n"
printf "\n"
printf "${BOLDGREEN}... ${ENDCOLOR}"
gcloud services enable cloudbuild.googleapis.com compute.googleapis.com apigateway.googleapis.com servicecontrol.googleapis.com eventarc.googleapis.com eventarcpublishing.googleapis.com appengine.googleapis.com firestore.googleapis.com iam.googleapis.com cloudfunctions.googleapis.com workflows.googleapis.com cloudresourcemanager.googleapis.com run.googleapis.com artifactregistry.googleapis.com --user-output-enabled=false
printf "${BOLDGREEN}done!${ENDCOLOR}\n"
printf "\n"

# TODO activarte Firestore Audit Log for cloud firestore eventrac

# create the firestore database (it is idempotent)
AGENT_DATABASE_NAME="agent-db-${HOST_SHORT_ID}"
printf "\n"
printf "${BOLDBLUE}* Agent Firestore Database:${ENDCOLOR}\n"
printf "\n"
if (gcloud firestore databases describe --database="${AGENT_DATABASE_NAME}" --format=none --verbosity=$VERBOSITY); then
    printf "Using existing database: ${ITALGREEN}${AGENT_DATABASE_NAME}${ENDCOLOR}\n"
else
    printf "Creating new database...\n"
    gcloud firestore databases create --database="${AGENT_DATABASE_NAME}" --location="${LOCATION}" --format=none --verbosity=$VERBOSITY
    printf "Database created: ${BOLDGREEN}${AGENT_DATABASE_NAME}${ENDCOLOR}\n"
fi
printf "\n"

#if (gcloud firestore indexes composite describe --database="${AGENT_DATABASE_NAME}" --format=none --verbosity=$VERBOSITY); then

printf "\n"
printf "${BOLDBLUE}* Agent Firestore Database Indexes:${ENDCOLOR}\n"
printf "\n"
# TODO: THIS CODE IS NOT ROBUST. WHAT HAPPEN IF THE CREATION OF ONE INDEX FAILS?
if (gcloud firestore indexes composite list --database="${AGENT_DATABASE_NAME}" --format="value(COLLECTION_GROUP)"); then
    printf "Index already existing for collection 'deployment'\n"
else
    printf "Creating new index for collecion 'deployment'...\n"
    gcloud firestore indexes composite create --database="${AGENT_DATABASE_NAME}" --collection-group=deployments --field-config=field-path=state,order=ascending --field-config=field-path=createdAt,order=ascending
    gcloud firestore indexes composite create --database="${AGENT_DATABASE_NAME}" --collection-group=deployments --field-config=field-path=state,order=ascending --field-config=field-path=createdAt,order=descending
    printf "Index created for collection 'deployment'.\n"
fi
printf "\n"

# create artifact registry
NODEJS_PACKAGES_REPOSITORY_NAME="nodejs-packages-${HOST_SHORT_ID}"
printf "\n"
printf "${BOLDBLUE}* Artifact registries:${ENDCOLOR}\n"
printf "\n"
if (gcloud artifacts repositories describe ${NODEJS_PACKAGES_REPOSITORY_NAME} --location="${LOCATION}" --format=none --verbosity=$VERBOSITY); then
    printf "Using existing ${NODEJS_PACKAGES_REPOSITORY_NAME} repository.\n"
else
    printf "Creating new repository...\n"
    gcloud artifacts repositories create ${NODEJS_PACKAGES_REPOSITORY_NAME} \
        --repository-format=npm \
        --location=$LOCATION \
        --description="nodejs packages for host ${HOST_ID}"
    printf "Repository created: ${BOLDGREEN}${NODEJS_PACKAGES_REPOSITORY_NAME}${ENDCOLOR}\n"
fi
printf "\n"

# create the buckets

printf "\n"
printf "${BOLDBLUE}* Agent Buckets:${ENDCOLOR}\n"
printf "\n"
ARCHITECTURES_BUCKET=$(create_bucket architectures) # TODO rename in architectures ?
printf "Using agent bucket: ${ITALGREEN}${ARCHITECTURES_BUCKET}${ENDCOLOR}\n"
SERVICES_ARCHIVE_BUCKET=$(create_bucket services-archive)
printf "Using services-archive bucket: ${ITALGREEN}${SERVICES_ARCHIVE_BUCKET}${ENDCOLOR}\n"
RESOURCES_ARCHIVE_BUCKET=$(create_bucket resources-archive)
printf "Using resources-archive bucket: ${ITALGREEN}${RESOURCES_ARCHIVE_BUCKET}${ENDCOLOR}\n"
printf "\n"

AGENT_DEPLOY_APP_WORKFLOW_NAME="agent-deploy-app-workflow-${HOST_SHORT_ID}"
AGENT_DEPLOY_APP_WORKFLOW=projects/$PROJECT_ID/locations/$LOCATION/workflows/$AGENT_DEPLOY_APP_WORKFLOW_NAME

# deploy the agent-backend
printf "\n"
printf "${BOLDBLUE}* Agent Backend function:${ENDCOLOR}\n"
printf "\n"

gcloud functions deploy "agent-backend-${HOST_SHORT_ID}" \
    --update-labels=backend-id=4234 \
    --gen2 \
    --entry-point=handle \
    --region=europe-west1 \
    --source=./functions/agent-backend/ \
    --trigger-http \
    --runtime=nodejs18 \
    --no-allow-unauthenticated \
    --set-env-vars "PROJECT_ID=${PROJECT_ID},LOCATION=${LOCATION},HOST_ID=${HOST_ID},HOST_SHORT_ID=${HOST_SHORT_ID},AGENT_DATABASE_NAME=${AGENT_DATABASE_NAME},AGENT_DEPLOY_APP_WORKFLOW=${AGENT_DEPLOY_APP_WORKFLOW},ARCHITECTURES_BUCKET=${ARCHITECTURES_BUCKET},SERVICES_ARCHIVE_BUCKET=${SERVICES_ARCHIVE_BUCKET},RESOURCES_ARCHIVE_BUCKET=${RESOURCES_ARCHIVE_BUCKET}"

AGENT_HOST_URL_SED=$(gcloud functions describe "agent-backend-${HOST_SHORT_ID}" --region=europe-west1 --gen2 --format="value(serviceConfig.uri)" | sed 's/\//\\\//g') 

printf "\n"
printf "Function deployed: ${BOLDGREEN}agent-backend-${HOST_SHORT_ID}${ENDCOLOR}\n"
printf "\n"

# deploy the workflows
printf "\n"
printf "${BOLDBLUE}* Agent deploy app workflow:${ENDCOLOR}\n"
printf "\n"
printf "Deploying workflow...\n"
sed "s/{{PROJECT_ID}}/$PROJECT_ID/g;s/{{LOCATION}}/$LOCATION/g;s/{{HOST_ID}}/$HOST_ID/g;s/{{HOST_SHORT_ID}}/$HOST_SHORT_ID/g;s/{{HOST_URL}}/$AGENT_HOST_URL_SED/g;s/{{SERVICES_ARCHIVE_BUCKET}}/$SERVICES_ARCHIVE_BUCKET/g;s/{{RESOURCES_ARCHIVE_BUCKET}}/$RESOURCES_ARCHIVE_BUCKET/g" ./workflows/AgentDeployAppWorkflow.yaml > AgentDeployAppWorkflow.yaml

gcloud workflows deploy $AGENT_DEPLOY_APP_WORKFLOW_NAME \
    --source=./AgentDeployAppWorkflow.yaml \
    --location=europe-west1 \
    --format=none \
    --verbosity=$VERBOSITY \
    --user-output-enabled=false
    
rm ./AgentDeployAppWorkflow.yaml

printf "Workflow deployed: ${BOLDGREEN}agent-backend-${HOST_SHORT_ID}${ENDCOLOR}\n"
printf "\n"

# deploy the API Gateway
printf "\n"
printf "${BOLDBLUE}* Agent API Gateway:${ENDCOLOR}\n"
printf "\n"

sed -e "s/\${organization}/${ORGANIZATION}/" -e "s/\${hostName}/${HOST_NAME}/" -e "s/\${hostUrl}/${AGENT_HOST_URL_SED}/" ./apigw/openapi.yaml > openapi.yaml

OPENAPI_HASH=$(md5 -q openapi.yaml)
AGENT_API_NAME="${HOST_SHORT_ID}"
AGENT_API_GW_NAME="${HOST_SHORT_ID}"
AGENT_API_CFG_NAME="${HOST_SHORT_ID}-${OPENAPI_HASH}"

if (gcloud api-gateway apis describe $AGENT_API_NAME --format=none --verbosity=$VERBOSITY); then
    printf "Using existing API: ${ITALGREEN}${AGENT_API_NAME}${ENDCOLOR}\n"
else
    printf "Creating new API...\n"
    gcloud api-gateway apis create $AGENT_API_NAME
    printf "API created: ${BOLDGREEN}${AGENT_API_NAME}${ENDCOLOR}\n"
fi

# TODO remove previous one
# gcloud api-gateway api-configs delete agent-api-cfg --api=agent-api --quiet || true
if (gcloud api-gateway api-configs describe $AGENT_API_CFG_NAME --api=$AGENT_API_NAME --format=none --verbosity=$VERBOSITY); then
    printf "Using existing API Config: ${ITALGREEN}${AGENT_API_CFG_NAME}${ENDCOLOR}\n"
else
    printf "Creating new API Config...\n"
    gcloud api-gateway api-configs create $AGENT_API_CFG_NAME --api=$AGENT_API_NAME --openapi-spec=./openapi.yaml
    printf "API Config created: ${BOLDGREEN}${AGENT_API_CFG_NAME}${ENDCOLOR}\n"
fi
rm ./openapi.yaml

AGENT_API_CFG_ID=$(gcloud api-gateway api-configs describe $AGENT_API_CFG_NAME --api=$AGENT_API_NAME --format="value(name)")

if (gcloud api-gateway gateways describe $AGENT_API_GW_NAME --location=europe-west1 --format=none --verbosity=$VERBOSITY); then
    AGENT_API_GW_CFG_ID=$(gcloud api-gateway gateways describe $AGENT_API_GW_NAME --location=europe-west1 --format="value(apiConfig)")
else
    AGENT_API_GW_CFG_ID=""
fi

if [ "$AGENT_API_GW_CFG_ID" = "" ]; then
    printf "Creating new API Gateway...\n"
    gcloud api-gateway gateways create $AGENT_API_GW_NAME --api=$AGENT_API_NAME --api-config=$AGENT_API_CFG_NAME --location=europe-west1 --project=${PROJECT_ID}
    printf "API Gateway created: ${BOLDGREEN}${AGENT_API_GW_NAME}${ENDCOLOR}\n"
elif [ "$AGENT_API_GW_CFG_ID" = "$AGENT_API_CFG_ID" ]; then
    printf "Using existing API Gateway: ${ITALGREEN}${AGENT_API_GW_NAME}${ENDCOLOR}\n"
else
    printf "Updating existing API Gateway...\n"
    gcloud api-gateway gateways update $AGENT_API_GW_NAME --api=$AGENT_API_NAME --api-config=$AGENT_API_CFG_NAME --location=europe-west1
    printf "API Gateway updated: ${BOLDGREEN}${AGENT_API_GW_NAME}${ENDCOLOR}\n"
fi

HOST_URL=$(gcloud api-gateway gateways describe $AGENT_API_GW_NAME --location=europe-west1 --format="value(defaultHostname)")

# deploy the function used in the pairing process
printf "\n"
printf "${BOLDBLUE}* Agent Pairing function${ENDCOLOR}\n"
printf "\n"

gcloud functions deploy "agent-pairing-${HOST_SHORT_ID}" \
    --update-labels=deployment-id=4234 \
    --gen2 \
    --entry-point=handle \
    --region=europe-west1 \
    --source=./functions/agent-pairing/ \
    --trigger-http \
    --runtime=nodejs18 \
    --allow-unauthenticated \
    --set-env-vars "PAIRING_SECRET_KEY=${PAIRING_SECRET_KEY},HOST_ID=${HOST_ID},HOST_URL=https://${HOST_URL}"

AGENT_PAIRING_URL=$(gcloud functions describe "agent-pairing-${HOST_SHORT_ID}" --region=europe-west1 --gen2 --format="value(serviceConfig.uri)") 

printf "\n"
printf "Function deployed: ${BOLDGREEN}agent-pairing-${HOST_SHORT_ID}${ENDCOLOR}\n"
printf "\n"


printf "\n"
printf "${BOLDWHITE}-----------------------------------------------------------------------------------------------------------------${ENDCOLOR}\n"
printf "\n"
printf "Almost done ! Click on ${BOLDWHITE}http://www.blueforge.cloud/new/host${ENDCOLOR} to create the host and provide the pairing URL:\n"
printf "\n"
printf ". Pairing url: ${LIGHTYELLOW}${AGENT_PAIRING_URL}?k=${PAIRING_SECRET_KEY}${ENDCOLOR}\n"
printf "\n"
printf "${BOLDWHITE}-----------------------------------------------------------------------------------------------------------------${ENDCOLOR}\n"
printf "\n"