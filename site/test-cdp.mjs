// Minimal root-page CDP client for optional local browser tests. Node built-ins only.
export class FrameCDP {
  static async open(port = Number(process.env.CDP_PORT || 9223)) {
    if (!Number.isInteger(port) || port < 1 || port > 65535 || port === 9222)
      throw Error('Use a dedicated Chrome debug port other than 9222');
    const base = `http://127.0.0.1:${port}`;
    const response = await fetch(`${base}/json/new?about:blank`, {method:'PUT', signal:AbortSignal.timeout(3000)});
    if (!response.ok) throw Error('Could not create Chrome test target');
    const target = await response.json();
    const client = new FrameCDP();
    Object.assign(client, {base, target, seq:0, pending:new Map()});
    try {
      client.ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(Error('Chrome connection timeout')), 3000);
        client.ws.onopen = () => {clearTimeout(timer); resolve();};
        client.ws.onerror = () => {clearTimeout(timer); reject(Error('Chrome connection failed'));};
      });
      client.ws.onmessage = event => {
        const message = JSON.parse(event.data), job = client.pending.get(message.id);
        if (!job) return;
        clearTimeout(job.timer); client.pending.delete(message.id);
        if (message.error) job.reject(Error(message.error.message));
        else job.resolve(message.result);
      };
      client.ws.onclose = () => {
        for (const job of client.pending.values()) {clearTimeout(job.timer); job.reject(Error('Chrome connection closed'));}
        client.pending.clear();
      };
      await client.root('Page.enable');
      await client.root('Runtime.enable');
      await client.root('Network.enable');
      return client;
    } catch (error) {await client.close(); throw error;}
  }

  root(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.seq;
      const timer = setTimeout(() => {this.pending.delete(id); reject(Error(`CDP timeout: ${method}`));}, 15000);
      this.pending.set(id, {resolve, reject, timer});
      try {this.ws.send(JSON.stringify({id, method, params}));}
      catch (error) {clearTimeout(timer); this.pending.delete(id); reject(error);}
    });
  }

  async evalRoot(expression) {
    const result = await this.root('Runtime.evaluate', {expression, returnByValue:true, awaitPromise:true});
    if (result.exceptionDetails)
      throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  }

  async waitRoot(expression) {
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      try {if (await this.evalRoot(expression)) return;}
      catch (error) {
        // Navigation can replace the execution context between readiness probes.
        if (!/Execution context was destroyed|Cannot find context/.test(error.message)) throw error;
      }
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw Error('Chrome page readiness timeout');
  }

  async close() {
    try {await fetch(`${this.base}/json/close/${this.target.id}`, {signal:AbortSignal.timeout(3000)});}
    finally {this.ws?.close();}
  }
}
