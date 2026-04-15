function createState() {
  return {
    pipelines: [],
    selectedPipelineId: "",
  };
}

function createPipeline(state, name) {
  if (!name || !name.trim()) return null;
  const pipeline = {
    id: `pl-${Date.now()}`,
    name: name.trim(),
    stages: [],
  };
  state.pipelines.push(pipeline);
  state.selectedPipelineId = pipeline.id;
  return pipeline;
}

function addStage(state, pipelineId, stageName) {
  const pipeline = state.pipelines.find((p) => p.id === pipelineId);
  if (!pipeline || !stageName || !stageName.trim()) return null;
  const stage = {
    id: `st-${Date.now()}-${pipeline.stages.length}`,
    name: stageName.trim(),
    agents: [],
  };
  pipeline.stages.push(stage);
  return stage;
}

function addAgent(state, pipelineId, stageId, agentName, responsibility) {
  const stage = findStage(state, pipelineId, stageId);
  if (!stage || !agentName || !agentName.trim()) return null;
  const agent = {
    id: `ag-${Date.now()}-${stage.agents.length}`,
    name: agentName.trim(),
    responsibility: (responsibility || "").trim(),
    skills: [],
  };
  stage.agents.push(agent);
  return agent;
}

function attachSkill(state, pipelineId, stageId, agentId, skillName, version) {
  const agent = findAgent(state, pipelineId, stageId, agentId);
  if (!agent || !skillName || !skillName.trim()) return null;
  const skill = {
    id: `sk-${Date.now()}-${agent.skills.length}`,
    name: skillName.trim(),
    version: (version || "latest").trim(),
  };
  agent.skills.push(skill);
  return skill;
}

function findSelectedPipeline(state) {
  return state.pipelines.find((p) => p.id === state.selectedPipelineId) || null;
}

function findStage(state, pipelineId, stageId) {
  const pipeline = state.pipelines.find((p) => p.id === pipelineId);
  if (!pipeline) return null;
  return pipeline.stages.find((s) => s.id === stageId) || null;
}

function findAgent(state, pipelineId, stageId, agentId) {
  const stage = findStage(state, pipelineId, stageId);
  if (!stage) return null;
  return stage.agents.find((a) => a.id === agentId) || null;
}

window.UIState = {
  createState,
  createPipeline,
  addStage,
  addAgent,
  attachSkill,
  findSelectedPipeline,
};
