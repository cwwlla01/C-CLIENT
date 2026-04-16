import { useEffect, useMemo, useRef, useState } from "react";
import { AgentRepoModal } from "./agent-repo-modal";
import {
  type AgentDefinition,
  elevationModeOptions,
  generateProjectName,
  availableAgentDefinitions,
  departmentOptions,
  permissionOptions,
  promptAutomationOptions,
  type ProjectNamingStrategy,
  roleOptions,
  shellOptions,
  type NewEmployeeForm,
} from "../data/mock-runtime";
import type { AppSettings } from "./settings-modal";
import type { AgentRepoState } from "../App";

type AddEmployeeModalProps = {
  agentRepoState: AgentRepoState;
  defaults: Pick<
    AppSettings,
    | "agentRepoUrl"
    | "defaultCompany"
    | "defaultDepartment"
    | "defaultPermission"
    | "defaultProjectStrategy"
    | "defaultShell"
    | "projectPath"
  >;
  onClose: () => void;
  onConfirm: (form: NewEmployeeForm) => void;
  onSyncAgentRepo: (refresh?: boolean) => Promise<void>;
  open: boolean;
};

type DropdownFieldProps = {
  label: string;
  onSelect: (next: string) => void;
  open: boolean;
  onToggle: (open: boolean) => void;
  options: readonly string[];
  value: string;
};

type AddEmployeeTab = "company" | "personal";

function DropdownField({
  label,
  onSelect,
  open,
  onToggle,
  options,
  value,
}: DropdownFieldProps) {
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        onToggle(false);
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    return () => document.removeEventListener("mousedown", handlePointerDown);
  }, [onToggle, open]);

  return (
    <div ref={rootRef} className="form-control relative gap-2">
      <label className="label px-0 pb-1 pt-0">
        <span className="label-text text-[13px] font-bold text-[#334155]">{label}</span>
      </label>

      <div className={`dropdown w-full ${open ? "dropdown-open" : ""}`}>
        <button
          className="btn btn-outline w-full justify-between bg-base-100 font-semibold normal-case text-base-content"
          onClick={() => onToggle(!open)}
          type="button"
        >
          <span className="truncate">{value}</span>
          <span className="text-xs text-base-content/60">⌄</span>
        </button>

        <ul className="menu dropdown-content z-[90] mt-2 w-full rounded-box border border-base-300 bg-base-100 p-2 shadow-lg">
          {options.map((option) => (
            <li key={option}>
              <button
                className={value === option ? "active" : ""}
                onClick={() => {
                  onSelect(option);
                  onToggle(false);
                }}
                type="button"
              >
                {option}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

function createInitialForm(
  defaults: Pick<
    AppSettings,
    | "agentRepoUrl"
    | "defaultCompany"
    | "defaultDepartment"
    | "defaultPermission"
    | "defaultProjectStrategy"
    | "defaultShell"
    | "projectPath"
  >,
): NewEmployeeForm {
  return {
    agentDefinitionText:
      availableAgentDefinitions[0]?.definitionText ??
      "name: default_agent\nrole: 默认 Agent\nprompt: |\n  请补充定义。",
    autoTrustWorkspace: true,
    company: defaults.defaultCompany,
    currentTask: "",
    department: defaults.defaultDepartment,
    elevationMode: "manual",
    employeeCode: "EMP-2026-024",
    name: "",
    permission: defaults.defaultPermission,
    promptAutomation: "safe_auto",
    projectName: generateProjectName(
      defaults.defaultProjectStrategy as ProjectNamingStrategy,
    ),
    repoSource: availableAgentDefinitions[0]?.repoSource ?? "",
    role: roleOptions[0],
    shell: defaults.defaultShell,
    workspace: defaults.projectPath,
  };
}

function normalizeSegment(segment: string, fallback: string) {
  const value = segment.trim() || fallback;
  return value.replace(/[<>:"/\\|?*\u0000-\u001F]/g, "-").trim();
}

export function AddEmployeeModal({
  agentRepoState,
  defaults,
  onClose,
  onConfirm,
  onSyncAgentRepo,
  open,
}: AddEmployeeModalProps) {
  const hasInitializedRef = useRef(false);
  const [form, setForm] = useState<NewEmployeeForm>(() => createInitialForm(defaults));
  const [selectedAgent, setSelectedAgent] = useState<AgentDefinition | null>(
    availableAgentDefinitions[0] ?? null,
  );
  const [agentModalOpen, setAgentModalOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<AddEmployeeTab>("company");
  const [openDropdown, setOpenDropdown] = useState<
    null | "department" | "permission" | "role" | "shell" | "promptAutomation" | "elevation"
  >(null);

  useEffect(() => {
    if (!open) {
      hasInitializedRef.current = false;
      return;
    }
    if (hasInitializedRef.current) {
      return;
    }

    setForm(createInitialForm(defaults));
    setSelectedAgent(agentRepoState.agents[0] ?? availableAgentDefinitions[0] ?? null);
    setActiveTab("company");
    setOpenDropdown(null);
    hasInitializedRef.current = true;
  }, [agentRepoState.agents, defaults, open]);

  const selectedAgentLabel = useMemo(
    () => selectedAgent?.name || "手动编辑",
    [selectedAgent],
  );
  const previewWorkspace = useMemo(() => {
    const root = (form.workspace.trim() || defaults.projectPath).replace(/[\\/]+$/, "");
    const company = normalizeSegment(form.company, defaults.defaultCompany);
    const department = normalizeSegment(form.department, defaults.defaultDepartment);
    const employeeName = normalizeSegment(form.name, "新员工");
    const projectName = normalizeSegment(form.projectName, "prj-preview");

    return `${root}/${company}/${department}/${employeeName}/${projectName}`;
  }, [
    defaults.defaultCompany,
    defaults.defaultDepartment,
    defaults.projectPath,
    form.company,
    form.department,
    form.name,
    form.projectName,
    form.workspace,
  ]);

  if (!open) {
    return null;
  }

  return (
    <>
      <dialog open className="modal z-[110] bg-[#0F172A5E] backdrop-blur-md">
        <div className="modal-box flex h-[88vh] max-h-[880px] max-w-[744px] flex-col overflow-hidden p-0">
          <form
            className="flex min-h-0 flex-1 flex-col"
            onSubmit={(event) => {
              event.preventDefault();
              onConfirm({
                ...form,
                repoSource: selectedAgent?.repoSource ?? form.repoSource,
              });
            }}
          >
            <div className="shrink-0 space-y-5 border-b border-base-300 bg-base-100 px-6 pb-5 pt-6">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1.5">
                  <p className="text-[26px] font-bold text-[#111827]">新增员工</p>
                  <p className="max-w-[520px] text-[13px] font-medium text-[#64748B]">
                    录入基础信息并绑定 Agent 定义，创建后即可进入员工档案。
                  </p>
                </div>
                <button className="btn btn-ghost btn-sm" onClick={onClose} type="button">
                  ESC
                  <span className="ml-1 text-[11px] font-bold text-[#94A3B8]">关闭</span>
                </button>
              </div>

              <div className="alert alert-info shadow-none">
                <span className="status status-info"></span>
                <p className="text-[13px] font-bold text-[#1D4ED8]">
                  创建后将自动同步员工目录、权限组与欢迎流程。
                </p>
              </div>

              <div className="tabs tabs-boxed w-fit gap-2 bg-base-200 p-1">
                <button
                  className={`tab ${activeTab === "company" ? "tab-active" : ""}`}
                  onClick={() => setActiveTab("company")}
                  type="button"
                >
                  公司信息
                </button>
                <button
                  className={`tab ${activeTab === "personal" ? "tab-active" : ""}`}
                  onClick={() => setActiveTab("personal")}
                  type="button"
                >
                  个人信息
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto px-6 py-5 min-h-0">
              <div className="space-y-5">
                {activeTab === "company" ? (
                  <div className="space-y-5">
                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="form-control gap-2">
                        <label className="label px-0 pb-1 pt-0">
                          <span className="label-text text-[13px] font-bold text-[#334155]">
                            公司
                          </span>
                        </label>
                        <input
                          className="input input-bordered h-12 bg-base-100 text-[14px] font-semibold text-base-content focus:outline-none"
                          onChange={(event) =>
                            setForm((current) => ({ ...current, company: event.target.value }))
                          }
                          value={form.company}
                        />
                      </div>

                      <DropdownField
                        label="部门"
                        onSelect={(next) =>
                          setForm((current) => ({ ...current, department: next }))
                        }
                        onToggle={(isOpen) =>
                          setOpenDropdown(isOpen ? "department" : null)
                        }
                        open={openDropdown === "department"}
                        options={departmentOptions}
                        value={form.department}
                      />
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <div className="form-control gap-2">
                        <label className="label px-0 pb-1 pt-0">
                          <span className="label-text text-[13px] font-bold text-[#334155]">
                            姓名
                          </span>
                        </label>
                        <input
                          className="input input-bordered h-12 bg-base-100 text-[14px] font-semibold text-base-content focus:outline-none"
                          onChange={(event) =>
                            setForm((current) => ({ ...current, name: event.target.value }))
                          }
                          placeholder="李晓宁"
                          required
                          value={form.name}
                        />
                      </div>

                      <div className="form-control gap-2">
                        <label className="label px-0 pb-1 pt-0">
                          <span className="label-text text-[13px] font-bold text-[#334155]">
                            员工编号
                          </span>
                        </label>
                        <input
                          className="input input-bordered h-12 bg-base-100 text-[14px] font-semibold text-base-content focus:outline-none"
                          onChange={(event) =>
                            setForm((current) => ({
                              ...current,
                              employeeCode: event.target.value,
                            }))
                          }
                          value={form.employeeCode}
                        />
                      </div>
                    </div>

                    <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_220px]">
                      <div className="form-control gap-2">
                        <label className="label px-0 pb-1 pt-0">
                          <span className="label-text text-[13px] font-bold text-[#334155]">
                            项目根路径
                          </span>
                        </label>
                        <input
                          className="input input-bordered h-12 bg-base-100 text-[14px] font-semibold text-base-content focus:outline-none"
                          onChange={(event) =>
                            setForm((current) => ({ ...current, workspace: event.target.value }))
                          }
                          value={form.workspace}
                        />
                      </div>

                      <DropdownField
                        label="岗位"
                        onSelect={(next) => setForm((current) => ({ ...current, role: next }))}
                        onToggle={(isOpen) => setOpenDropdown(isOpen ? "role" : null)}
                        open={openDropdown === "role"}
                        options={roleOptions}
                        value={form.role}
                      />
                    </div>

                    <div className="card border border-base-300 bg-base-100 shadow-none">
                      <div className="card-body gap-4 p-4">
                        <div className="flex items-center justify-between">
                          <h3 className="card-title text-base">项目空间</h3>
                          <span className="badge badge-outline">
                            {defaults.defaultProjectStrategy}
                          </span>
                        </div>
                        <div className="form-control gap-2">
                          <label className="label px-0 pb-1 pt-0">
                            <span className="label-text text-[13px] font-bold text-[#334155]">
                              项目名
                            </span>
                          </label>
                          <input
                            className="input input-bordered h-12 bg-base-100 text-[14px] font-semibold text-base-content focus:outline-none"
                            onChange={(event) =>
                              setForm((current) => ({ ...current, projectName: event.target.value }))
                            }
                            value={form.projectName}
                          />
                        </div>
                        <div className="rounded-box bg-base-200 px-4 py-3">
                          <p className="text-[11px] uppercase tracking-[0.16em] text-base-content/50">
                            项目空间预览
                          </p>
                          <p className="mt-2 break-all text-sm text-base-content/70">{previewWorkspace}</p>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}

                {activeTab === "personal" ? (
                  <div className="space-y-5">
                    <div className="grid gap-4 md:grid-cols-2">
                      <DropdownField
                        label="Shell"
                        onSelect={(next) => setForm((current) => ({ ...current, shell: next }))}
                        onToggle={(isOpen) => setOpenDropdown(isOpen ? "shell" : null)}
                        open={openDropdown === "shell"}
                        options={shellOptions}
                        value={form.shell}
                      />

                      <DropdownField
                        label="权限模式"
                        onSelect={(next) =>
                          setForm((current) => ({ ...current, permission: next }))
                        }
                        onToggle={(isOpen) =>
                          setOpenDropdown(isOpen ? "permission" : null)
                        }
                        open={openDropdown === "permission"}
                        options={permissionOptions}
                        value={form.permission}
                      />
                    </div>

                    <div className="grid gap-4 md:grid-cols-2">
                      <DropdownField
                        label="提示自动化"
                        onSelect={(next) =>
                          setForm((current) => ({
                            ...current,
                            promptAutomation:
                              promptAutomationOptions.find((option) => option.label === next)?.value ??
                              current.promptAutomation,
                          }))
                        }
                        onToggle={(isOpen) =>
                          setOpenDropdown(isOpen ? "promptAutomation" : null)
                        }
                        open={openDropdown === "promptAutomation"}
                        options={promptAutomationOptions.map((option) => option.label)}
                        value={
                          promptAutomationOptions.find((option) => option.value === form.promptAutomation)?.label ??
                          promptAutomationOptions[0].label
                        }
                      />

                      <DropdownField
                        label="提权处理"
                        onSelect={(next) =>
                          setForm((current) => ({
                            ...current,
                            elevationMode: elevationModeOptions.find((option) => option.label === next)?.value ?? current.elevationMode,
                          }))
                        }
                        onToggle={(isOpen) =>
                          setOpenDropdown(isOpen ? "elevation" : null)
                        }
                        open={openDropdown === "elevation"}
                        options={elevationModeOptions.map((option) => option.label)}
                        value={
                          elevationModeOptions.find((option) => option.value === form.elevationMode)?.label ??
                          elevationModeOptions[0].label
                        }
                      />
                    </div>

                    <label className="label cursor-pointer justify-start gap-3 rounded-box border border-base-300 bg-base-100 px-4 py-3">
                      <input
                        checked={form.autoTrustWorkspace}
                        className="toggle toggle-primary"
                        onChange={(event) =>
                          setForm((current) => ({
                            ...current,
                            autoTrustWorkspace: event.target.checked,
                          }))
                        }
                        type="checkbox"
                      />
                      <span className="label-text">
                        自动信任员工工作空间
                        <span className="ml-2 text-xs text-base-content/60">
                          启动时遇到 Codex 的目录信任提示可自动继续
                        </span>
                      </span>
                    </label>

                    <div className="space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[13px] font-bold text-[#334155]">
                          个人素质（Agent定义）
                        </span>
                        <div className="badge badge-success badge-outline gap-2 px-3 py-3 text-[11px] font-bold">
                          <span className="status status-success"></span>
                          {selectedAgentLabel}
                        </div>
                      </div>

                      <div className="card bg-base-200 p-4 shadow-none">
                        <div className="rounded-box bg-base-100 px-4 py-3">
                          <p className="text-[11px] uppercase tracking-[0.16em] text-base-content/50">
                            当前来源
                          </p>
                          <p className="mt-2 break-all text-sm text-base-content/70">
                            {(selectedAgent?.repoSource ?? form.repoSource) || "手动编辑"}
                          </p>
                        </div>

                        <textarea
                          className="textarea textarea-bordered mt-4 min-h-[196px] w-full bg-base-100 px-4 py-3 text-[13px] leading-6 text-base-content focus:outline-none"
                          onChange={(event) =>
                            setForm((current) => ({
                              ...current,
                              agentDefinitionText: event.target.value,
                            }))
                          }
                          value={form.agentDefinitionText}
                        />

                        <div className="mt-3 flex items-center justify-between gap-3">
                          <span className="text-[12px] font-semibold text-[#94A3B8]">
                            支持手动编辑；后续也会在这里追加 Skill 扩展能力。
                          </span>
                          <div className="flex gap-3">
                            <button
                              className="btn btn-primary px-4"
                              onClick={() => {
                                void onSyncAgentRepo(false);
                                setAgentModalOpen(true);
                              }}
                              type="button"
                            >
                              Agent 仓库
                            </button>
                            <button
                              className="btn btn-outline px-4"
                              onClick={() =>
                                setForm((current) => ({ ...current, agentDefinitionText: "" }))
                              }
                              type="button"
                            >
                              清空文本
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>

            <div className="modal-action mt-0 shrink-0 justify-end gap-3 border-t border-base-300 bg-base-100 px-6 py-4">
              <button className="btn btn-outline px-4" onClick={onClose} type="button">
                取消
              </button>
              <button className="btn btn-primary px-5" type="submit">
                确认创建
              </button>
            </div>
          </form>
        </div>
        <form className="modal-backdrop" method="dialog">
          <button onClick={onClose} type="button">
            关闭
          </button>
        </form>
      </dialog>

      <AgentRepoModal
        agents={agentRepoState.agents}
        commit={agentRepoState.commit}
        error={agentRepoState.error}
        loading={agentRepoState.loading}
        onApply={(agent) => {
          setSelectedAgent(agent);
          setForm((current) => ({
            ...current,
            agentDefinitionText: agent.definitionText,
            repoSource: agent.repoSource,
          }));
          setAgentModalOpen(false);
        }}
        onClose={() => setAgentModalOpen(false)}
        onRefresh={() => void onSyncAgentRepo(true)}
        open={agentModalOpen}
        repoUrl={defaults.agentRepoUrl}
        selectedAgentId={selectedAgent?.id ?? null}
        warning={agentRepoState.warning}
      />
    </>
  );
}
