// Shared remote runtime selection. SSH and Docker keep execution on the target.
export const runtimePrefix = p => p.execution === 'ssh' ? [] : ['sudo', '-n', p.dockerPath || '/usr/local/bin/docker', 'exec', '-i', p.container];
export const codexExecutable = p => p.codexPath || 'codex';
export const quote = s => "'" + String(s).replace(/'/g, "'\''") + "'";
export function sshCommand(p, command) {
  const args = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'UpdateHostKeys=no', '-o', 'ConnectTimeout=8', '-o', 'ServerAliveInterval=15'];
  if (p.sshPort) args.push('-p', String(p.sshPort));
  args.push('-i', p.sshKeyPath, `${p.sshUser}@${p.sshHost}`, command.map(quote).join(' '));
  return { command: 'ssh', args };
}
