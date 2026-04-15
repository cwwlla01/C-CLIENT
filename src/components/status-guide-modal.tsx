export function StatusGuideModal({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  if (!open) {
    return null;
  }

  return (
    <dialog open className="modal z-40 bg-[#020617]/72 backdrop-blur-sm">
      <div className="modal-box flex h-[74vh] max-h-[700px] max-w-[720px] flex-col overflow-hidden p-0">
        <div className="shrink-0 border-b border-base-300 px-6 py-4">
          <div className="flex items-center gap-3">
            <div>
              <p className="text-lg font-semibold text-base-content">状态说明</p>
              <p className="text-sm text-base-content/65">
                主状态描述 CLI 生命周期，工作态描述任务推进情况。
              </p>
            </div>
            <button
              className="btn btn-ghost btn-sm ml-auto"
              onClick={onClose}
              type="button"
            >
              关闭
            </button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div className="grid gap-4 md:grid-cols-2">
            <section className="card bg-base-200 p-4 shadow-none">
              <div className="flex items-center gap-2">
                <span className="badge badge-success badge-outline">运行中</span>
              </div>
              <p className="mt-3 text-sm leading-6 text-base-content/75">
                当前已经存在活动中的 CLI 会话，可以直接进入终端交互。
              </p>
            </section>

            <section className="card bg-base-200 p-4 shadow-none">
              <div className="flex items-center gap-2">
                <span className="badge badge-outline">已停止</span>
                <span className="badge badge-secondary badge-outline">待恢复</span>
              </div>
              <p className="mt-3 text-sm leading-6 text-base-content/75">
                当前没有活动中的 CLI。带“待恢复”说明磁盘里有历史运行上下文，可通过“重启 CLI”恢复。
              </p>
            </section>

            <section className="card bg-base-200 p-4 shadow-none">
              <div className="flex items-center gap-2">
                <span className="badge badge-error badge-outline">异常</span>
              </div>
              <p className="mt-3 text-sm leading-6 text-base-content/75">
                启动、重启或运行过程中发生了非预期问题，需要先处理错误原因，再继续恢复。
              </p>
            </section>

            <section className="card bg-base-200 p-4 shadow-none">
              <div className="flex items-center gap-2">
                <span className="badge badge-info badge-outline">忙碌中</span>
                <span className="badge badge-warning badge-outline">阻塞中</span>
                <span className="badge badge-ghost badge-outline">空闲</span>
              </div>
              <p className="mt-3 text-sm leading-6 text-base-content/75">
                这些是工作态，不等同于 CLI 生命周期。员工可以“运行中且阻塞中”，也可以“已停止但任务仍待恢复”。
              </p>
            </section>
          </div>
        </div>

        <div className="shrink-0 border-t border-base-300 bg-base-100 px-6 py-4">
          <div className="modal-action mt-0 justify-end">
            <button className="btn btn-primary" onClick={onClose} type="button">
              我知道了
            </button>
          </div>
        </div>
      </div>
      <form className="modal-backdrop" method="dialog">
        <button onClick={onClose} type="button">
          关闭
        </button>
      </form>
    </dialog>
  );
}
