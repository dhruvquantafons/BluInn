const $ = (id) => document.getElementById(id);
window.bluinn.onStatus((message) => { $("status").textContent = `${message}…`; });
window.bluinn.onFailed(({ message, logs }) => {
  $("starting").hidden = true;
  $("failed").hidden = false;
  $("message").textContent = message;
  $("logs").textContent = logs;
});
$("retry").onclick = () => window.bluinn.retry();
$("open-logs").onclick = () => window.bluinn.openLogs();
