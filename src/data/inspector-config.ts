export type InspectorInspectionMode = "rules_only" | "hybrid" | "ai_only";
export type InspectorAutopilotMode = "off" | "suggest_only" | "safe_auto" | "full_auto";

export type InspectorSettings = {
  ai: {
    apiKey: string;
    baseUrl: string;
    enabled: boolean;
    maxTokens: number;
    model: string;
    reasoningEffort: "low" | "medium" | "high";
  };
  allowedReplyTypes: string[];
  autoReplyEnabled: boolean;
  autopilotMode: InspectorAutopilotMode;
  blockedReplyTypes: string[];
  enabled: boolean;
  highRiskAlwaysManual: boolean;
  inspectionMode: InspectorInspectionMode;
  preferences: {
    preferConservative: boolean;
    preferContinue: boolean;
    preferNonDestructive: boolean;
    preferOptionA: boolean;
  };
  thresholds: {
    autoReplyScore: number;
    blockedScore: number;
    completionScore: number;
    silenceSeconds: number;
  };
};

export function createDefaultInspectorSettings(): InspectorSettings {
  return {
    ai: {
      apiKey: "",
      baseUrl: "",
      enabled: false,
      maxTokens: 1200,
      model: "gpt-5.4-mini",
      reasoningEffort: "low",
    },
    allowedReplyTypes: [
      "choice_ab",
      "choice_numeric",
      "confirm_yes_no",
    ],
    autoReplyEnabled: true,
    autopilotMode: "suggest_only",
    blockedReplyTypes: [
      "destructive_confirm",
      "mass_overwrite",
      "publish_confirm",
      "network_side_effect",
    ],
    enabled: true,
    highRiskAlwaysManual: true,
    inspectionMode: "rules_only",
    preferences: {
      preferConservative: true,
      preferContinue: true,
      preferNonDestructive: true,
      preferOptionA: false,
    },
    thresholds: {
      autoReplyScore: 80,
      blockedScore: 50,
      completionScore: 60,
      silenceSeconds: 20,
    },
  };
}
