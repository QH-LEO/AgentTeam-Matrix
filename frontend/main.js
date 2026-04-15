const { createApp } = window.Vue;
const { addAgent, addStage, attachSkill, createPipeline, createState, findSelectedPipeline } = window.UIState;

createApp({
  data() {
    return {
      ...createState(),
      menuItems: [
        { key: "pipeline", label: "流水线管理" },
        { key: "stage", label: "阶段编排" },
        { key: "agent", label: "Agent 职责" },
        { key: "skill", label: "Skill 管理" },
      ],
      activeMenu: "pipeline",
      pipelineName: "",
      stageName: "",
      agentStageId: "",
      agentName: "",
      agentResponsibility: "",
      skillStageId: "",
      skillAgentId: "",
      skillName: "",
      skillVersion: "1.0.0",
    };
  },
  computed: {
    activeMenuLabel() {
      const target = this.menuItems.find((item) => item.key === this.activeMenu);
      return target ? target.label : "工作台";
    },
    selectedPipeline() {
      return findSelectedPipeline(this);
    },
    agentsBySelectedStage() {
      if (!this.selectedPipeline || !this.skillStageId) return [];
      const stage = this.selectedPipeline.stages.find((s) => s.id === this.skillStageId);
      return stage ? stage.agents : [];
    },
    selectedAgentForSkill() {
      const agent = this.agentsBySelectedStage.find((a) => a.id === this.skillAgentId);
      return agent || null;
    },
  },
  methods: {
    createPipeline() {
      const pipeline = createPipeline(this, this.pipelineName);
      if (!pipeline) return;
      this.pipelineName = "";
    },
    selectPipeline(id) {
      this.selectedPipelineId = id;
      this.agentStageId = "";
      this.skillStageId = "";
      this.skillAgentId = "";
      this.activeMenu = "stage";
    },
    addStage() {
      if (!this.selectedPipeline) return;
      const stage = addStage(this, this.selectedPipeline.id, this.stageName);
      if (!stage) return;
      this.stageName = "";
      if (!this.agentStageId) this.agentStageId = stage.id;
      if (!this.skillStageId) this.skillStageId = stage.id;
    },
    addAgent() {
      if (!this.selectedPipeline || !this.agentStageId) return;
      const agent = addAgent(
        this,
        this.selectedPipeline.id,
        this.agentStageId,
        this.agentName,
        this.agentResponsibility
      );
      if (!agent) return;
      this.agentName = "";
      this.agentResponsibility = "";
      if (this.skillStageId === this.agentStageId) this.skillAgentId = agent.id;
    },
    attachSkill() {
      if (!this.selectedPipeline || !this.skillStageId || !this.skillAgentId) return;
      const skill = attachSkill(
        this,
        this.selectedPipeline.id,
        this.skillStageId,
        this.skillAgentId,
        this.skillName,
        this.skillVersion
      );
      if (!skill) return;
      this.skillName = "";
    },
  },
}).mount("#app");
