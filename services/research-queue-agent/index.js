'use strict';
/** AUTONOMOUS_RESEARCH_QUEUE_V1 Q2：无工具代理、验证器与路由。入口模块；各部分见同目录文件。 */
const lexicon = require('./lexicon');
const facts = require('./facts');
const prompts = require('./prompts');
const agent = require('./agent');
const queueSeam = require('./queue-seam');
const admission = require('./mechanism-admission-stub');
const routing = require('./routing');
const { validateCheckReport } = require('./check-report');
const { validateCard } = require('./card');
const { validateIdeaDraft, validateIdeaRecord, buildIdeaRecords } = require('./factor-idea');
const { createGatewayClient } = require('./gateway-client');

module.exports = {
  lexicon, prompts, agent, queueSeam, admission,
  validateCheckReport, validateCard, validateIdeaDraft, validateIdeaRecord, buildIdeaRecords,
  checkPack: facts.checkPack, splitPackByRow: facts.splitPackByRow,
  agentHostFor: routing.agentHostFor, assertAgentHost: routing.assertAgentHost, routeIdea: routing.routeIdea, triageViaRegister: routing.triageViaRegister,
  buildIdeasInView: routing.buildIdeasInView,
  runAgentTask: agent.runAgentTask, createGatewayClient,
};
