# install necessary tools
apt-get install -y curl jq docker-io

# create a user and group for github runners
addgroup runner
adduser --system --disabled-password --home /home/runner --ingroup runner runner
cd /home/runner

# download github runners
GITHUB_RUNNER_VERSION=$(curl -s https://api.github.com/repos/actions/runner/releases/latest | jq -r .tag_name | sed 's/v//g')
curl -sSLO https://github.com/actions/runner/releases/download/v${GITHUB_RUNNER_VERSION}/actions-runner-linux-x64-${GITHUB_RUNNER_VERSION}.tar.gz
tar -zxvf actions-runner-linux-x64-${GITHUB_RUNNER_VERSION}.tar.gz
rm -f actions-runner-linux-x64-${GITHUB_RUNNER_VERSION}.tar.gz

# invoke install dependencies in the runner
./bin/installdependencies.sh

chown -R runner:runner /home/runner

# configure the service
RUNNER_NAME="default"
RUNNER_WORKDIR="_work"
GITHUB_ACCESS_TOKEN="{{{GITHUB_ACCESS_TOKEN}}}"
GITHUB_ACTIONS_RUNNER_CONTEXT="{{{GITHUB_ACTIONS_RUNNER_CONTEXT}}}"

if [[ -z "${GITHUB_ACCESS_TOKEN}"]]; then
  echo 'GITHUB_ACCESS_TOKEN is missing. Quit!'
  exit 1
fi

if [[ -z "${GITHUB_ACTIONS_RUNNER_CONTEXT}" ]]; then
  echo 'GITHUB_ACTIONS_RUNNER_CONTEXT is missing. Quit!'
  exit 1
fi

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

./config.sh --url "${GITHUB_ACTIONS_RUNNER_CONTEXT}" --token "${RUNNER_TOKEN}" --name "${RUNNER_NAME}" --work "${RUNNER_WORKDIR}"
./run.sh
