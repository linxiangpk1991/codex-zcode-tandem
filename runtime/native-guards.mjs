import { resumeRunApproved } from './policy.mjs';
import { inspectWorkflowBinding } from './workflow-contract.mjs';

// Guard at request arrival too: upstream's orphan-session sweep can otherwise
// auto-allow workflow tools without reaching the ACP client permission path.
export function installNativeGuards(Backend, { send, request, isPermissionRequest,
  platform = process.platform }) {
  const watchdog = Backend.prototype.startWatchdog;
  Backend.prototype.startWatchdog = function () {
    const pid = this.proc.pid;
    if (pid) send({ type: 'native_started', pid });
    this.proc.once('exit', () => {
      if (process.connected) send({ type: 'native_exited', pid });
    });
    if (platform !== 'win32') return watchdog.call(this);
  };
  const handle = Backend.prototype.handleServerRequest;
  Backend.prototype.handleServerRequest = function (req) {
    const p = req.params ?? {};
    if (isPermissionRequest(req.method)) {
      const workflow = ['CreateWorkflow', 'AmendWorkflow'].includes(p.toolName);
      const resume = p.toolName === 'ResumeWorkflowRun';
      const binding = workflow ? inspectWorkflowBinding(request, p.input) : null;
      const allowed = workflow ? binding.matched
        && (p.toolName !== 'AmendWorkflow' || resumeRunApproved(request, p.input))
        : resume ? resumeRunApproved(request, p.input) : true;
      if (!allowed) {
        const reason = `Controller workflow binding mismatch: ${binding?.reason ?? 'predecessor run ID mismatch'}`;
        this.sendReply(req.id, { decision: 'deny', reason });
        send({ type: 'policy_denied', toolName: p.toolName, reason });
        return true;
      }
    }
    return handle.call(this, req);
  };
}
