"""Forced SSH command for the model-harbor deployment key only."""
import os
import re
import shlex
import sys

try:
    args = shlex.split(os.environ.get('SSH_ORIGINAL_COMMAND', ''))
except ValueError:
    sys.exit(126)
prefix = ['sudo', '-n', '/usr/local/bin/docker', 'exec', '-i', 'codex-linux']
allowed = False
image_runner = prefix + ['python3', '/workspace/model-harbor/codex-image-runner.py']
if args == image_runner + ['check']:
    allowed = True
if (len(args) == len(image_runner) + 2 and args[:len(image_runner)] == image_runner
        and args[-2] == 'generate' and re.fullmatch(r'[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}', args[-1])):
    allowed = True
tail = ['codex', 'exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--ignore-rules', '-C', '/tmp', '-s', 'read-only', '-c', 'approval_policy="never"', '-c', 'features.shell_tool=false', '-c', 'features.apply_patch_freeform=false', '-m']
if args[:6] == prefix:
    rest = args[6:]
    if (len(rest) == 4 + len(tail) + 2 and rest[:3] == ['timeout', '--signal=TERM', '--kill-after=5s']
            and re.fullmatch(r'[0-9]{2,3}s', rest[3])
            and 10 <= int(rest[3][:-1]) <= 600
            and rest[4:-2] == tail and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.-]{0,199}', rest[-2]) and rest[-1] == '-'):
        allowed = True
agent_tail = ['timeout', '--signal=TERM', '--kill-after=5s', '1200s', 'codex', 'app-server', '--listen', 'stdio://', '-c', 'features.shell_tool=false', '-c', 'features.apply_patch_freeform=false', '-c', 'features.multi_agent=false', '-c', 'features.image_generation=false', '-c', 'features.apps=false', '-c', 'features.plugins=false', '-c', 'web_search="disabled"']
if args == prefix + agent_tail:
    allowed = True
claude_prefix = ['sudo', '-n', '/usr/local/bin/docker', 'exec', '-i', 'claude-linux']
claude_tail = ['claude', '-p', '--output-format', 'json', '--input-format', 'text',
               '--no-session-persistence', '--safe-mode', '--strict-mcp-config',
               '--tools', '', '--permission-mode', 'dontAsk', '--permission-prompts', 'none',
               '--model']
if args[:6] == claude_prefix:
    rest = args[6:]
    if (len(rest) == 4 + len(claude_tail) + 1
            and rest[:3] == ['timeout', '--signal=TERM', '--kill-after=5s']
            and re.fullmatch(r'[0-9]{2,3}s', rest[3])
            and 10 <= int(rest[3][:-1]) <= 600
            and rest[4:-1] == claude_tail
            and re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}', rest[-1])):
        allowed = True

if args == claude_prefix + ['timeout', '--signal=TERM', '--kill-after=5s', '610s', 'python3', '/workspace/model-harbor/claude-tool-runner.py', '--cli', 'claude']:
    allowed = True

claude_usage = claude_prefix + ['python3', '/workspace/model-harbor/claude-usage.py']
if args == claude_usage:
    allowed = True

if not allowed:
    sys.stderr.write('Model Harbor SSH command denied\n')
    sys.exit(126)
os.execvp(args[0], args)
