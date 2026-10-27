import { expect, it } from "vitest";
import { scheduleCheckView } from "../web/views.js";

it("SCH-19 formats pending, passed, not-ready, failed, and stop-only check diagnostics without hiding zero exit codes", () => {
	expect(scheduleCheckView({})).toBeNull();
	const pending = scheduleCheckView({ check: "./ready", checkCwd: "/tmp/project", stopAfterSuccess: true });
	expect(pending).toMatchObject({ status: "Not checked yet" });
	expect(pending!.text).toContain("Check command:\n./ready");
	expect(pending!.text).toContain("Working directory: /tmp/project");
	expect(pending!.text).toContain("Stop after successful dispatch: Yes");
	expect(pending!.text).toContain("Last check: Not checked yet");
	for (const [status, label, exitCode] of [["passed", "Passed", 0], ["not_ready", "Not ready", 1], ["failed", "Failed", null]] as const) {
		const view = scheduleCheckView({ check: "./ready", lastCheck: {
			checkedAt: 123, status, exitCode, signal: status === "failed" ? "SIGTERM" : null,
			stdout: "<script>not executable</script>", stderr: "diagnostic stderr", error: status === "failed" ? "check timed out" : null,
		} }, time => `time ${time}`)!;
		expect(view.status).toBe(label);
		expect(view.text).toContain("Checked at: time 123");
		expect(view.text).toContain(`Exit code: ${exitCode ?? "None"}`);
		expect(view.text).toContain(`Signal: ${status === "failed" ? "SIGTERM" : "None"}`);
		expect(view.text).toContain(`Error: ${status === "failed" ? "check timed out" : "None"}`);
		expect(view.text).toContain("Standard output:\n<script>not executable</script>");
		expect(view.text).toContain("Standard error:\ndiagnostic stderr");
	}
	const stopOnly = scheduleCheckView({ stopAfterSuccess: true })!;
	expect(stopOnly.text).toContain("None (dispatch without a readiness check)");
	expect(stopOnly.text).toContain("Last check: No check recorded");
	expect(stopOnly.text).not.toContain("Exit code:");
	// A retained historical result remains visible even after the check is removed.
	expect(scheduleCheckView({ check: null, lastCheck: { status: "passed", checkedAt: 0, exitCode: 0, signal: null, stdout: "", stderr: "", error: null } })!.text).toContain("Standard output:\n(empty)");
});
