// Cloudflare can return a new deployment ID before its GET endpoint is ready.
// Retry that initial 404 briefly; permission errors and later failures still stop.
export async function readNewDeployment(read, { pause, attempts = 7 } = {}) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try { return await read(); }
    catch (error) {
      if (error.status !== 404 || attempt === attempts - 1) throw error;
      await pause(5000);
    }
  }
}
