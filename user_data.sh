#!/bin/bash
set -e

# install docker - instructions are at https://docs.docker.com/engine/install/ubuntu/#install-using-the-repository
apt install -y apt-transport-https ca-certificates curl gnupg lsb-release
if test -f /usr/share/keyrings/docker-archive-keyring.gpg; then
  rm -f /usr/share/keyrings/docker-archive-keyring.gpg
fi
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /usr/share/keyrings/docker-archive-keyring.gpg
echo "deb [arch=amd64 signed-by=/usr/share/keyrings/docker-archive-keyring.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
apt update
apt install -y docker-ce docker-ce-cli containerd.io

# install necessary tools
apt install -y git jq

# install aws cli
apt install -y unzip
curl https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip -o awscliv2.zip
unzip awscliv2.zip
./aws/install

# create a user and group for github runners
addgroup runner
adduser --system --disabled-password --home /home/runner --ingroup runner runner
cd /home/runner

# download github runners
GITHUB_RUNNER_VERSION=$(curl -s https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed 's/v//g')
curl -sSLO https://github.com/actions/runner/releases/download/v${GITHUB_RUNNER_VERSION}/actions-runner-linux-x64-${GITHUB_RUNNER_VERSION}.tar.gz
tar -zxvf actions-runner-linux-x64-${GITHUB_RUNNER_VERSION}.tar.gz
rm -f actions-runner-linux-x64-${GITHUB_RUNNER_VERSION}.tar.gz

# retrieve the instance id
INSTANCE_ID=$(curl http://169.254.169.254/latest/meta-data/instance-id)

# invoke install dependencies in the runner
./bin/installdependencies.sh

# configure the service
RUNNER_NAME="default"
RUNNER_WORKDIR="_work"
GITHUB_ACCESS_TOKEN="{{{GITHUB_ACCESS_TOKEN}}}"
GITHUB_ACTIONS_RUNNER_CONTEXT="{{{GITHUB_ACTIONS_RUNNER_CONTEXT}}}"

AUTH_HEADER="Authorization: token ${GITHUB_ACCESS_TOKEN}"
USERNAME=$(cut -d/ -f4 <<< ${GITHUB_ACTIONS_RUNNER_CONTEXT})
REPOSITORY=$(cut -d/ -f5 <<< ${GITHUB_ACTIONS_RUNNER_CONTEXT})

if [[ -z "${REPOSITORY}" ]]; then 
TOKEN_REGISTRATION_URL="https://api.github.com/orgs/${USERNAME}/actions/runners/registration-token"
else
TOKEN_REGISTRATION_URL="https://api.github.com/repos/${USERNAME}/${REPOSITORY}/actions/runners/registration-token"
fi

RUNNER_TOKEN="$(curl -XPOST -fsSL \
-H "Accept: application/vnd.github.v3+json" \
-H "${AUTH_HEADER}" \
"${TOKEN_REGISTRATION_URL}" \
| jq -r '.token')"

RUNNER_ALLOW_RUNASROOT=1 ./config.sh --url "${GITHUB_ACTIONS_RUNNER_CONTEXT}" --token "${RUNNER_TOKEN}" --name "${RUNNER_NAME}" --work "${RUNNER_WORKDIR}" --labels "${INSTANCE_ID},self-hosted"
chown -R runner:runner /home/runner
chmod -R 0777 /home/runner
RUNNER_ALLOW_RUNASROOT=1 ./svc.sh install
RUNNER_ALLOW_RUNASROOT=1 ./svc.sh start
