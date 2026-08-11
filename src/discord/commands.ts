export const CODEX_COMMAND = {
  name: "codex",
  description: "Control Codex agent sessions",
  type: 1,
  integration_types: [0],
  contexts: [0, 1],
  options: [
    { type: 1, name: "status", description: "Show the current Codex session status" },
    { type: 1, name: "models", description: "List available Codex models" },
    {
      type: 1,
      name: "model",
      description: "Change the Codex model",
      options: [
        {
          type: 3,
          name: "name",
          description: "Model ID or default",
          required: true,
          min_length: 1,
          max_length: 256,
        },
      ],
    },
    {
      type: 1,
      name: "reasoning",
      description: "Change the reasoning effort",
      options: [
        {
          type: 3,
          name: "effort",
          description: "Reasoning effort or default",
          required: true,
          min_length: 1,
          max_length: 64,
        },
      ],
    },
    {
      type: 1,
      name: "new",
      description: "Start a new Codex session",
      options: [
        {
          type: 5,
          name: "confirm",
          description: "Confirm replacement of the current session",
          required: false,
        },
      ],
    },
    { type: 1, name: "interrupt", description: "Interrupt the current Codex turn" },
    {
      type: 1,
      name: "spawn",
      description: "Create and start a Codex agent",
      options: [
        { type: 3, name: "bot", description: "Registered bot name", required: true },
        { type: 3, name: "workspace", description: "Configured workspace name", required: true },
      ],
    },
    { type: 1, name: "stop", description: "Stop the current Codex agent" },
    { type: 1, name: "restart", description: "Restart the current Codex agent" },
  ],
} as const;

export type CodexSubcommand =
  | "status"
  | "models"
  | "model"
  | "reasoning"
  | "new"
  | "interrupt"
  | "spawn"
  | "stop"
  | "restart";
