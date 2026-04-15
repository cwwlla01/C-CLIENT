export type PromptRuleAction =
  | "enter"
  | "reply_1"
  | "reply_2"
  | "reply_y"
  | "reply_n"
  | "route_pending";

export type PromptRule = {
  action: PromptRuleAction;
  enabled: boolean;
  id: string;
  name: string;
  pattern: string;
};

export const promptRuleActionOptions: Array<{
  label: string;
  value: PromptRuleAction;
}> = [
  { label: "回车继续", value: "enter" },
  { label: "回复 1", value: "reply_1" },
  { label: "回复 2", value: "reply_2" },
  { label: "回复 y", value: "reply_y" },
  { label: "回复 n", value: "reply_n" },
  { label: "转待确认", value: "route_pending" },
];

export function createEmptyPromptRule(index: number): PromptRule {
  return {
    action: "route_pending",
    enabled: true,
    id: `prompt-rule-${Date.now().toString(36)}-${index}`,
    name: `规则 ${index + 1}`,
    pattern: "",
  };
}
