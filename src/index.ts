import { Application } from "probot"; // eslint-disable-line no-unused-vars
import { GitHubAPI } from "probot/lib/github";
import yaml from "js-yaml";
import minimatch from "minimatch";

interface Label {
  id: string;
  createdAt: string;
  name: string;
}

interface Config {
  groups: (string | string[])[];
}

interface QueryResult {
  labelableId: string;
  config: Config;
  labels: Label[];
}

async function query(
  github: GitHubAPI,
  owner: string,
  repo: string,
  number: number
): Promise<QueryResult> {
  const data = await github.query(
    `
    query Query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) {
        object(expression: "HEAD:.github/label-juggler.yml") {
          ... on Blob {
            text
          }
        }
        issueOrPullRequest(number: $number) {
          ... on Node {
            id
          }
          ... on Labelable {
            labels(last: 100) {
              nodes {
                id
                createdAt
                name
              }
            }
          }
        }
      }
    }
  `,
    {
      owner,
      repo,
      number
    }
  );

  return {
    labelableId: data.repository.issueOrPullRequest.id,
    config: yaml.safeLoad(data.repository.object.text) as Config,
    labels: data.repository.issueOrPullRequest.labels.nodes as Label[]
  };
}

function groupBy<T>(
  list: T[],
  keyFn: (item: T) => string
): { [key: string]: T[] } {
  return list.reduce(
    (groups, item) => {
      const key = keyFn(item);
      const itemList = [item];
      return {
        ...groups,
        [key]: groups[key] ? groups[key].concat(itemList) : itemList
      };
    },
    {} as { [key: string]: T[] }
  );
}

async function evaluate(
  github: GitHubAPI,
  owner: string,
  repo: string,
  number: number,
  labelIds: string[]
) {
  const result = await query(github, owner, repo, number);
  const labels = [
    ...result.labels.filter(label => labelIds.includes(label.id)),
    ...result.labels.filter(label => !labelIds.includes(label.id))
  ];

  const labelGroups = groupBy(labels, label =>
    getGroup(result.config.groups, label.name)
  );

  const labelIdsToRemove = Object.entries(labelGroups)
    .filter(([groupName]) => groupName !== "")
    .flatMap(([, matchedLabels]) => matchedLabels.slice(1))
    .map(label => label.id);

  if (labelIdsToRemove.length === 0) {
    return;
  }

  await github.query(
    `
  mutation RemoveLabels($labelableId: ID!, $labelIds: [ID!]!) {
    removeLabelsFromLabelable(input: {
      labelIds: $labelIds,
      labelableId: $labelableId
    }) {
      clientMutationId
    }
  }
  `,
    {
      labelableId: result.labelableId,
      labelIds: labelIdsToRemove
    }
  );
}

function getGroup(groupConfig: Config["groups"], label: string): string {
  for (let [index, group] of groupConfig.entries()) {
    if (typeof group === "string") {
      if (minimatch(label, group)) {
        return index.toString();
      }
    } else {
      if (group.includes(label)) {
        return index.toString();
      }
    }
  }
  return "";
}

export = (app: Application) => {
  app.on(["issues.opened", "issues.labeled"], async context => {
    const owner = context.payload.repository.owner.login;
    const repo = context.payload.repository.name;
    const number = context.payload.issue.number;
    // const labelIds = context.payload.labels.map((label: any) => label.node_id);
    const labelIds = [context.payload.label.node_id];

    await evaluate(context.github, owner, repo, number, labelIds);
  });
  app.on(["pull_requests.opened", "pull_requests.labeled"], async context => {
    const owner = context.payload.pull_request.repository.owner.login;
    const repo = context.payload.pull_request.repository.name;
    const number = context.payload.pull_request.number;
    // const labelIds = context.payload.labels.map((label: any) => label.node_id);
    const labelIds = [context.payload.label.node_id];

    await evaluate(context.github, owner, repo, number, labelIds);
  });
};
