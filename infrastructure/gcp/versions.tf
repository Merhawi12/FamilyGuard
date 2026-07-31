terraform {
  required_version = ">= 1.6.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.12"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.12"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # State must not live on one laptop: it is the only record of which real
  # resources Terraform owns, and losing it means re-importing everything by
  # hand. Create the bucket once (see README), then `terraform init`.
  backend "gcs" {
    # bucket is supplied by -backend-config in deploy.sh, so one config serves
    # every environment.
    prefix = "parentix/state"
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}
