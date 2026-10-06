const { StringDecoder } = require("node:string_decoder");

function createOpencodeEventStream({ httpImpl, host, port, onMessage, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let request;
  let timer;
  let stopped = false;
  let generation = 0;
  let failures = 0;
  function connect() {
    if (stopped) return;
    const current = ++generation;
    let ended = false;
    function reconnect() {
      if (ended || stopped || current !== generation) return;
      ended = true;
      request?.destroy();
      timer = setTimer(connect, Math.min(10_000, 250 * 2 ** Math.min(failures++, 6)));
      timer?.unref?.();
    }
    request = httpImpl.get({ host, port, path: "/global/event" }, (response) => {
      if (stopped || current !== generation) { response.destroy(); return; }
      if (response.statusCode !== 200) { response.resume?.(); reconnect(); return; }
      failures = 0;
      onMessage(JSON.stringify({ type: "server.connected", properties: {} }));
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      let data = [];
      response.on("data", (chunk) => {
        if (ended || stopped || current !== generation) return;
        buffer += decoder.write(chunk);
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).replace(/\r$/, "");
          buffer = buffer.slice(newline + 1);
          if (!line) {
            if (data.length) onMessage(data.join("\n"));
            data = [];
          } else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
        }
      });
      response.on("end", reconnect);
      response.on("close", reconnect);
      response.on("error", reconnect);
    });
    request.on("error", reconnect);
  }
  connect();
  return { stop() { stopped = true; generation += 1; clearTimer(timer); request?.destroy(); } };
}

module.exports = { createOpencodeEventStream };
