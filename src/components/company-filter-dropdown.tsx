import { useEffect, useRef } from "react";

type CompanyFilterDropdownProps = {
  companies: string[];
  onChange: (next: string) => void;
  onToggle: (open: boolean) => void;
  open: boolean;
  value: string;
};

export function CompanyFilterDropdown({
  companies,
  onChange,
  onToggle,
  open,
  value,
}: CompanyFilterDropdownProps) {
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

  useEffect(() => {
    if (open) {
      onToggle(false);
    }
  }, [onToggle, open, value]);

  const currentLabel = value === "all" ? "全部公司" : value;

  return (
    <div ref={rootRef} className="form-control w-[152px] gap-1">
      <div className={`dropdown w-full ${open ? "dropdown-open" : ""}`}>
        <button
          className="btn btn-outline btn-sm w-full justify-between bg-base-100 font-medium normal-case"
          onClick={() => onToggle(!open)}
          type="button"
        >
          <span className="truncate">{currentLabel}</span>
          <span className="text-xs text-base-content/60">⌄</span>
        </button>

        <ul className="menu dropdown-content z-[90] mt-2 w-full rounded-box border border-base-300 bg-base-100 p-2 shadow-lg">
          <li>
            <button
              className={value === "all" ? "active" : ""}
              onClick={() => {
                onChange("all");
                onToggle(false);
              }}
              type="button"
            >
              全部公司
            </button>
          </li>
          {companies.map((company) => (
            <li key={company}>
              <button
                className={value === company ? "active" : ""}
                onClick={() => {
                  onChange(company);
                  onToggle(false);
                }}
                type="button"
              >
                {company}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
