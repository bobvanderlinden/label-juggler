import {
  toLambda
} from "probot-serverless-now"

import applicationFunction from "./"

module.exports = toLambda(applicationFunction as any);
