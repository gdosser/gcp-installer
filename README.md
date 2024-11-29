# gcp-installer

On cloud shell, run:

curl -o cloudbuild.yaml "https://raw.githubusercontent.com/gdosser/gcp-installer/main/cloudbuild.yaml" && gcloud builds submit --config=cloudbuild.yaml .