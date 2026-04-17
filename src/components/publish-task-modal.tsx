import { useEffect, useMemo, useRef, useState } from "react";
import {
  generateProjectName,
  type ProjectNamingStrategy,
  type RuntimeMember,
} from "../data/mock-runtime";

export type TaskReferenceAttachmentInput = {
  contentBase64: string;
  isImage: boolean;
  mimeType: string;
  name: string;
  size: number;
};

type PublishTaskModalProps = {
  members: RuntimeMember[];
  onClose: () => void;
  onConfirm: (payload: {
    attachments: TaskReferenceAttachmentInput[];
    company: string;
    department: string;
    memberId: string;
    projectName: string;
    priority: "P0" | "P1" | "P2" | "P3";
    source: string;
    taskDescription: string;
    timeWindow: RelativeTimeWindow;
  }) => void;
  defaultProjectStrategy: ProjectNamingStrategy;
  open: boolean;
  preferredCompany?: string;
};

type DropdownFieldProps = {
  label: string;
  onSelect: (next: string) => void;
  open: boolean;
  onToggle: (open: boolean) => void;
  options: Array<{ label: string; value: string }>;
  value: string;
};

type TaskReferenceDraft = TaskReferenceAttachmentInput & {
  id: string;
  previewDataUrl: string | null;
};

type PublishTaskTab = "task" | "employee";
type RelativeTimeWindow =
  | "within_30m"
  | "within_1h"
  | "within_3h"
  | "within_12h"
  | "within_24h"
  | "no_deadline";

const MAX_REFERENCE_COUNT = 8;
const MAX_REFERENCE_FILE_BYTES = 10 * 1024 * 1024;
const MAX_REFERENCE_TOTAL_BYTES = 20 * 1024 * 1024;
const deadlinePreviewFormatter = new Intl.DateTimeFormat("zh-CN", {
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  month: "numeric",
});
const timeWindowOptions: Array<{ description: string; label: string; value: RelativeTimeWindow }> = [
  {
    description: "高优先事项，适合需要马上响应的短任务。",
    label: "30 分钟内",
    value: "within_30m",
  },
  {
    description: "适合小型修复、整理和快速确认类任务。",
    label: "1 小时内",
    value: "within_1h",
  },
  {
    description: "适合需要少量分析与实现的常规工作。",
    label: "3 小时内",
    value: "within_3h",
  },
  {
    description: "适合半天内推进完的任务。",
    label: "12 小时内",
    value: "within_12h",
  },
  {
    description: "适合今天到明天内完成的任务。",
    label: "24 小时内",
    value: "within_24h",
  },
  {
    description: "仅记录优先级，不设置具体截止时刻。",
    label: "无明确截止",
    value: "no_deadline",
  },
];

function formatFileSize(size: number) {
  if (size >= 1024 * 1024) {
    return `${(size / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (size >= 1024) {
    return `${Math.max(1, Math.round(size / 1024))} KB`;
  }
  return `${size} B`;
}

function readFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error(`读取文件失败：${file.name}`));
    reader.readAsDataURL(file);
  });
}

function describeTimeWindow(value: RelativeTimeWindow) {
  return timeWindowOptions.find((option) => option.value === value) || {
    description: "适合需要少量分析与实现的常规工作。",
    label: "3 小时内",
    value: "within_3h" as const,
  };
}

function computeRelativeDeadlinePreview(value: RelativeTimeWindow) {
  const now = new Date();
  const next = new Date(now);

  switch (value) {
    case "within_30m":
      next.setMinutes(next.getMinutes() + 30);
      break;
    case "within_1h":
      next.setHours(next.getHours() + 1);
      break;
    case "within_3h":
      next.setHours(next.getHours() + 3);
      break;
    case "within_12h":
      next.setHours(next.getHours() + 12);
      break;
    case "within_24h":
      next.setHours(next.getHours() + 24);
      break;
    case "no_deadline":
      return null;
    default:
      return null;
  }

  return deadlinePreviewFormatter.format(next);
}

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
    <div ref={rootRef} className="form-control gap-2">
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
            <li key={option.value}>
              <button
                className={value === option.label ? "active" : ""}
                onClick={() => {
                  onSelect(option.value);
                  onToggle(false);
                }}
                type="button"
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export function PublishTaskModal({
  defaultProjectStrategy,
  members,
  onClose,
  onConfirm,
  open,
  preferredCompany,
}: PublishTaskModalProps) {
  const hasInitializedRef = useRef(false);
  const previousMemberIdRef = useRef("");
  const [priority, setPriority] = useState<"P0" | "P1" | "P2" | "P3">("P1");
  const [taskDescription, setTaskDescription] = useState("");
  const [referenceFiles, setReferenceFiles] = useState<TaskReferenceDraft[]>([]);
  const [referenceError, setReferenceError] = useState("");
  const [isReadingReferences, setIsReadingReferences] = useState(false);
  const [source, setSource] = useState("手动发布");
  const [timeWindow, setTimeWindow] = useState<RelativeTimeWindow>("within_3h");
  const [selectedCompany, setSelectedCompany] = useState("");
  const [selectedDepartment, setSelectedDepartment] = useState("");
  const [selectedMemberId, setSelectedMemberId] = useState("");
  const [projectName, setProjectName] = useState("");
  const [activeTab, setActiveTab] = useState<PublishTaskTab>("task");
  const [openDropdown, setOpenDropdown] = useState<
    null | "company" | "department" | "member" | "priority" | "timeWindow" | "source"
  >(null);

  const companies = useMemo(
    () =>
      Array.from(new Set(members.map((member) => member.company).filter(Boolean))).sort(
        (left, right) => left.localeCompare(right, "zh-CN"),
      ),
    [members],
  );

  const departments = useMemo(
    () =>
      Array.from(
        new Set(
          members
            .filter((member) => member.company === selectedCompany)
            .map((member) => member.department)
            .filter(Boolean),
        ),
      ).sort((left, right) => left.localeCompare(right, "zh-CN")),
    [members, selectedCompany],
  );

  const employeeOptions = useMemo(
    () =>
      members
        .filter(
          (member) =>
            member.company === selectedCompany &&
            member.department === selectedDepartment,
        )
        .sort((left, right) => left.name.localeCompare(right.name, "zh-CN")),
        [members, selectedCompany, selectedDepartment],
  );

  const selectedMember = useMemo(
    () => employeeOptions.find((member) => member.id === selectedMemberId) ?? null,
    [employeeOptions, selectedMemberId],
  );

  const companyOptions = useMemo(
    () => companies.map((company) => ({ label: company, value: company })),
    [companies],
  );

  const departmentOptions = useMemo(
    () => departments.map((department) => ({ label: department, value: department })),
    [departments],
  );

  const employeeDropdownOptions = useMemo(
    () =>
      employeeOptions.map((member) => ({
        label: member.name,
        value: member.id,
      })),
    [employeeOptions],
  );

  const sourceOptions = useMemo(
    () => [
      { label: "手动发布", value: "手动发布" },
      { label: "CEO", value: "CEO" },
      { label: "部门负责人", value: "部门负责人" },
      { label: "系统自动", value: "系统自动" },
    ],
    [],
  );
  const selectedTimeWindowOption = useMemo(() => describeTimeWindow(timeWindow), [timeWindow]);
  const deadlinePreview = useMemo(() => computeRelativeDeadlinePreview(timeWindow), [timeWindow]);

  useEffect(() => {
    if (!open) {
      hasInitializedRef.current = false;
      return;
    }
    if (hasInitializedRef.current) {
      return;
    }
    if (companies.length === 0) {
      return;
    }

    const initialCompany =
      preferredCompany && companies.includes(preferredCompany)
        ? preferredCompany
        : companies[0] ?? "";
    const initialDepartments = Array.from(
      new Set(
        members
          .filter((member) => member.company === initialCompany)
          .map((member) => member.department)
          .filter(Boolean),
      ),
    ).sort((left, right) => left.localeCompare(right, "zh-CN"));
    const initialDepartment = initialDepartments[0] ?? "";
    const initialMembers = members
      .filter(
        (member) =>
          member.company === initialCompany &&
          member.department === initialDepartment,
      )
      .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));

    setPriority("P1");
    setSource("手动发布");
    setTimeWindow("within_3h");
    setTaskDescription("");
    setReferenceFiles([]);
    setReferenceError("");
    setIsReadingReferences(false);
    setSelectedCompany(initialCompany);
    setSelectedDepartment(initialDepartment);
    setSelectedMemberId(initialMembers[0]?.id ?? "");
    setProjectName(initialMembers[0]?.projectName ?? generateProjectName(defaultProjectStrategy));
    setActiveTab("task");
    previousMemberIdRef.current = initialMembers[0]?.id ?? "";
    setOpenDropdown(null);
    hasInitializedRef.current = true;
  }, [companies, defaultProjectStrategy, members, open, preferredCompany]);

  useEffect(() => {
    if (!selectedCompany || departments.includes(selectedDepartment)) {
      return;
    }
    setSelectedDepartment(departments[0] ?? "");
  }, [departments, selectedCompany, selectedDepartment]);

  useEffect(() => {
    if (!selectedDepartment || employeeOptions.some((member) => member.id === selectedMemberId)) {
      return;
    }
    setSelectedMemberId(employeeOptions[0]?.id ?? "");
  }, [employeeOptions, selectedDepartment, selectedMemberId]);

  useEffect(() => {
    if (!selectedMemberId || previousMemberIdRef.current === selectedMemberId) {
      return;
    }

    const matchedMember = employeeOptions.find((member) => member.id === selectedMemberId);
    if (!matchedMember) {
      return;
    }

    previousMemberIdRef.current = selectedMemberId;
    setProjectName(matchedMember.projectName);
  }, [employeeOptions, selectedMemberId]);

  if (!open) {
    return null;
  }

  return (
    <dialog open className="modal z-[110] bg-[#0F172A5E] backdrop-blur-md">
      <div className="modal-box flex h-[78vh] max-h-[760px] max-w-[680px] flex-col overflow-hidden p-0">
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            onConfirm({
              attachments: referenceFiles.map(({ contentBase64, isImage, mimeType, name, size }) => ({
                contentBase64,
                isImage,
                mimeType,
                name,
                size,
              })),
              company: selectedCompany,
              department: selectedDepartment,
              memberId: selectedMemberId,
              projectName,
              priority,
              source,
              taskDescription,
              timeWindow,
            });
          }}
        >
          <div className="shrink-0 space-y-4 border-b border-base-300 bg-base-100 px-6 pb-5 pt-6">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1.5">
                <p className="text-[26px] font-bold text-[#111827]">发布任务</p>
                <p className="max-w-[480px] text-[13px] font-medium text-[#64748B]">
                  将原始需求写入目标员工的 task_request.md；如果目标员工当前未运行，客户端会自动启动它先生成计划再执行。
                </p>
              </div>
              <button className="btn btn-ghost btn-sm" onClick={onClose} type="button">
                ESC
                <span className="ml-1 text-[11px] font-bold text-[#94A3B8]">关闭</span>
              </button>
            </div>

            <div className="tabs tabs-boxed w-fit gap-2 bg-base-200 p-1">
              <button
                className={`tab ${activeTab === "task" ? "tab-active" : ""}`}
                onClick={() => setActiveTab("task")}
                type="button"
              >
                任务详情
              </button>
              <button
                className={`tab ${activeTab === "employee" ? "tab-active" : ""}`}
                onClick={() => setActiveTab("employee")}
                type="button"
              >
                员工信息
              </button>
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
            <div className="space-y-5">
              {activeTab === "employee" ? (
                <>
                  <div className="grid gap-4 md:grid-cols-3">
                    <DropdownField
                      label="公司"
                      onSelect={setSelectedCompany}
                      onToggle={(isOpen) => setOpenDropdown(isOpen ? "company" : null)}
                      open={openDropdown === "company"}
                      options={companyOptions}
                      value={selectedCompany || "请选择公司"}
                    />

                    <DropdownField
                      label="部门"
                      onSelect={setSelectedDepartment}
                      onToggle={(isOpen) => setOpenDropdown(isOpen ? "department" : null)}
                      open={openDropdown === "department"}
                      options={departmentOptions}
                      value={selectedDepartment || "请选择部门"}
                    />

                    <DropdownField
                      label="员工"
                      onSelect={setSelectedMemberId}
                      onToggle={(isOpen) => setOpenDropdown(isOpen ? "member" : null)}
                      open={openDropdown === "member"}
                      options={employeeDropdownOptions}
                      value={selectedMember?.name || "请选择员工"}
                    />
                  </div>

                  <div className="card bg-base-200 p-4 shadow-none">
                    <div className="flex flex-wrap items-center gap-2 text-sm text-base-content/75">
                      <span>目标员工：</span>
                      <span className="badge badge-outline rounded-md">{selectedMember?.name ?? "-"}</span>
                      <span className="badge badge-outline rounded-md">{selectedMember?.runtimeStatus ?? "unknown"}</span>
                      <span className="badge badge-outline rounded-md">{selectedMember?.permission ?? "-"}</span>
                      <span className="badge badge-outline rounded-md">{selectedMember?.role ?? "-"}</span>
                    </div>
                    <p className="mt-3 break-all text-xs text-base-content/60">
                      {selectedMember?.workspace ?? "请先选择员工"}
                    </p>
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      <div className="rounded-box bg-base-100 px-4 py-3">
                        <p className="text-[11px] uppercase tracking-[0.16em] text-base-content/50">当前项目</p>
                        <p className="mt-2 text-sm font-semibold text-base-content">{selectedMember?.projectName ?? "-"}</p>
                      </div>
                      <div className="rounded-box bg-base-100 px-4 py-3">
                        <p className="text-[11px] uppercase tracking-[0.16em] text-base-content/50">员工编号</p>
                        <p className="mt-2 text-sm font-semibold text-base-content">{selectedMember?.employeeCode ?? "-"}</p>
                      </div>
                    </div>
                  </div>
                </>
              ) : null}

              {activeTab === "task" ? (
                <>
                  <div className="grid gap-4 md:grid-cols-[160px_minmax(0,1fr)]">
                    <DropdownField
                      label="优先级"
                      onSelect={(next) => setPriority(next as "P0" | "P1" | "P2" | "P3")}
                      onToggle={(isOpen) => setOpenDropdown(isOpen ? "priority" : null)}
                      open={openDropdown === "priority"}
                      options={[
                        { label: "P0", value: "P0" },
                        { label: "P1", value: "P1" },
                        { label: "P2", value: "P2" },
                        { label: "P3", value: "P3" },
                      ]}
                      value={priority}
                    />

                    <DropdownField
                      label="时间窗口"
                      onSelect={(next) =>
                        setTimeWindow(next as RelativeTimeWindow)
                      }
                      onToggle={(isOpen) => setOpenDropdown(isOpen ? "timeWindow" : null)}
                      open={openDropdown === "timeWindow"}
                      options={timeWindowOptions.map(({ label, value }) => ({ label, value }))}
                      value={selectedTimeWindowOption.label}
                    />
                  </div>

                  <div className="rounded-box border border-base-300 bg-base-200 px-4 py-4">
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <p className="text-sm font-semibold text-base-content">时限说明</p>
                        <p className="text-sm text-base-content/70">
                          {selectedTimeWindowOption.description}
                        </p>
                      </div>
                      <span className="badge badge-outline rounded-md">
                        {selectedTimeWindowOption.label}
                      </span>
                    </div>
                    <p className="mt-3 text-xs text-base-content/60">
                      {deadlinePreview
                        ? `系统会按发布时间自动换算，预计截止时间：${deadlinePreview}`
                        : "系统不会生成具体截止时间，只记录相对时限为“无明确截止”。"}
                    </p>
                  </div>

                  <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_220px]">
                    <div className="form-control gap-2">
                      <label className="label px-0 pb-1 pt-0">
                        <span className="label-text text-[13px] font-bold text-[#334155]">
                          项目名
                        </span>
                      </label>
                      <div className="join">
                        <input
                          className="input input-bordered join-item flex-1"
                          onChange={(event) => setProjectName(event.target.value)}
                          placeholder="prj-xxxx"
                          value={projectName}
                        />
                        <button
                          className="btn btn-outline join-item"
                          onClick={() => setProjectName(generateProjectName(defaultProjectStrategy))}
                          type="button"
                        >
                          随机生成
                        </button>
                      </div>
                    </div>

                    <DropdownField
                      label="指派来源"
                      onSelect={setSource}
                      onToggle={(isOpen) => setOpenDropdown(isOpen ? "source" : null)}
                      open={openDropdown === "source"}
                      options={sourceOptions}
                      value={source}
                    />
                  </div>

                  <div className="form-control gap-2">
                    <label className="label px-0 pb-1 pt-0">
                      <span className="label-text text-[13px] font-bold text-[#334155]">
                        需求描述
                      </span>
                    </label>
                    <textarea
                      className="textarea textarea-bordered min-h-[220px] bg-base-100 text-[14px] leading-6 text-base-content focus:outline-none"
                      onChange={(event) => setTaskDescription(event.target.value)}
                      placeholder="描述你要交付给员工执行的任务、目标、范围、约束和产出要求。"
                      required
                      value={taskDescription}
                    />
                  </div>

                  <div className="card bg-base-200 p-4 shadow-none">
                    <div className="flex flex-wrap items-center gap-2 text-sm text-base-content/75">
                      <span>投递目标：</span>
                      <span className="badge badge-outline rounded-md">{selectedMember?.name ?? "-"}</span>
                      <span className="badge badge-outline rounded-md">{projectName || "-"}</span>
                      <span className="badge badge-outline rounded-md">{selectedMember?.runtimeStatus ?? "unknown"}</span>
                    </div>
                    <p className="mt-3 break-all text-xs text-base-content/60">
                      {selectedMember?.workspace ?? "请先到员工信息页选择员工"}
                    </p>
                  </div>

                  <div className="form-control gap-3">
                <label className="label px-0 pb-1 pt-0">
                  <span className="label-text text-[13px] font-bold text-[#334155]">
                    参考资料
                  </span>
                </label>

                <div className="rounded-box border border-base-300 bg-base-200 p-4">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <p className="text-sm text-base-content/70">
                      支持上传图片、文档、代码片段等参考资料。它们会保存到员工项目空间的 `references/` 目录，并写入 `task_request.md`。
                    </p>
                    <label className={`btn btn-outline ${isReadingReferences ? "loading" : ""}`}>
                      {isReadingReferences ? "处理中" : "选择文件"}
                      <input
                        className="hidden"
                        multiple
                        onChange={async (event) => {
                          const selected = Array.from(event.target.files ?? []);
                          event.currentTarget.value = "";

                          if (selected.length === 0) {
                            return;
                          }

                          const combinedCount = referenceFiles.length + selected.length;
                          if (combinedCount > MAX_REFERENCE_COUNT) {
                            setReferenceError(`最多上传 ${MAX_REFERENCE_COUNT} 个参考文件`);
                            return;
                          }

                          const tooLarge = selected.find(
                            (file) => file.size > MAX_REFERENCE_FILE_BYTES,
                          );
                          if (tooLarge) {
                            setReferenceError(
                              `${tooLarge.name} 超过 ${formatFileSize(MAX_REFERENCE_FILE_BYTES)} 限制`,
                            );
                            return;
                          }

                          const currentTotal = referenceFiles.reduce(
                            (sum, file) => sum + file.size,
                            0,
                          );
                          const selectedTotal = selected.reduce(
                            (sum, file) => sum + file.size,
                            0,
                          );
                          if (currentTotal + selectedTotal > MAX_REFERENCE_TOTAL_BYTES) {
                            setReferenceError(
                              `参考资料总大小不能超过 ${formatFileSize(MAX_REFERENCE_TOTAL_BYTES)}`,
                            );
                            return;
                          }

                          setReferenceError("");
                          setIsReadingReferences(true);

                          try {
                            const drafts = await Promise.all(
                              selected.map(async (file, index) => {
                                const dataUrl = await readFileAsDataUrl(file);
                                const [, contentBase64 = ""] = dataUrl.split(",", 2);
                                const mimeType = file.type || "application/octet-stream";
                                const isImage = mimeType.startsWith("image/");

                                return {
                                  contentBase64,
                                  id: `${Date.now()}-${index}-${file.name}`,
                                  isImage,
                                  mimeType,
                                  name: file.name,
                                  previewDataUrl: isImage ? dataUrl : null,
                                  size: file.size,
                                } satisfies TaskReferenceDraft;
                              }),
                            );

                            setReferenceFiles((current) => [...current, ...drafts]);
                          } catch (error) {
                            setReferenceError(
                              error instanceof Error ? error.message : "读取参考资料失败",
                            );
                          } finally {
                            setIsReadingReferences(false);
                          }
                        }}
                        type="file"
                      />
                    </label>
                  </div>

                  <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-base-content/55">
                    <span className="badge badge-outline rounded-md">
                      最多 {MAX_REFERENCE_COUNT} 个文件
                    </span>
                    <span className="badge badge-outline rounded-md">
                      单文件 {formatFileSize(MAX_REFERENCE_FILE_BYTES)} 内
                    </span>
                    <span className="badge badge-outline rounded-md">
                      总计 {formatFileSize(MAX_REFERENCE_TOTAL_BYTES)} 内
                    </span>
                  </div>

                  {referenceError ? (
                    <div className="alert alert-error mt-3">
                      <span>{referenceError}</span>
                    </div>
                  ) : null}

                  {referenceFiles.length > 0 ? (
                    <div className="mt-4 grid gap-3 md:grid-cols-2">
                      {referenceFiles.map((file) => (
                        <div key={file.id} className="rounded-box border border-base-300 bg-base-100 p-3">
                          <div className="flex items-start gap-3">
                            {file.previewDataUrl ? (
                              <img
                                alt={file.name}
                                className="h-16 w-16 rounded-box object-cover"
                                src={file.previewDataUrl}
                              />
                            ) : (
                              <div className="flex h-16 w-16 items-center justify-center rounded-box bg-base-200 text-xs text-base-content/55">
                                文件
                              </div>
                            )}
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-semibold text-base-content">
                                {file.name}
                              </p>
                              <p className="mt-1 text-xs text-base-content/60">
                                {file.mimeType} · {formatFileSize(file.size)}
                              </p>
                              <div className="mt-3">
                                <button
                                  className="btn btn-outline btn-xs"
                                  onClick={() =>
                                    setReferenceFiles((current) =>
                                      current.filter((entry) => entry.id !== file.id),
                                    )
                                  }
                                  type="button"
                                >
                                  移除
                                </button>
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="mt-4 rounded-box border border-dashed border-base-300 px-4 py-4 text-sm text-base-content/55">
                      当前没有附加参考资料。
                    </div>
                  )}
                  </div>
                  </div>
                </>
              ) : null}
            </div>
          </div>

          <div className="modal-action mt-0 shrink-0 justify-end gap-3 border-t border-base-300 bg-base-100 px-6 py-4">
            <button className="btn btn-outline px-4" onClick={onClose} type="button">
              取消
            </button>
            <button
              className="btn btn-primary px-5"
              disabled={
                !selectedCompany ||
                !selectedDepartment ||
                !selectedMemberId ||
                !taskDescription.trim() ||
                isReadingReferences
              }
              type="submit"
            >
              发布任务
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
  );
}
