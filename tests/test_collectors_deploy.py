"""実機・ネットワークを使わず、自動更新の失敗と再試行を確認する。"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / 'collectors/deploy/collectors-deploy.sh'


class DeployRecoveryTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.repo = self.root / 'repo'
        self.repo.mkdir()
        self.state = self.root / 'state'
        self.bin = self.root / 'bin'
        self.bin.mkdir()
        self.env = dict(os.environ, HOME=str(self.root), MYROOM_REPO=str(self.repo),
                        MYROOM_COLLECTORS_STATE=str(self.state),
                        PATH=str(self.bin) + ':' + os.environ['PATH'],
                        TEST_ROOT=str(self.root))
        self.env.pop('MYROOM_DEPLOY_COPY', None)
        self.env.pop('DEPLOY_REF', None)
        self.git('init', '-b', 'main')
        self.git('config', 'user.email', 'test@example.com')
        self.git('config', 'user.name', 'Test')
        self.write('.gitignore', 'collectors/.venv-*\n')
        for n in ('a', 'b'):
            self.write(f'collectors/{n}.py', '# old\n')
            self.write(f'collectors/requirements-{n}.txt', 'old\n')
            self.write(f'collectors/systemd/{n}.service',
                       f'[Service]\nType=oneshot\nExecStart=x/collectors/.venv-{n}/bin/python x/collectors/{n}.py\n')
            self.write(f'collectors/systemd/{n}.timer', '[Timer]\nOnCalendar=hourly\n')
            v = self.repo / f'collectors/.venv-{n}'
            self.executable(v / 'bin/python', '#!/bin/sh\nexit 0\n')
            self.executable(v / 'bin/pip', '#!/bin/sh\nv=$(dirname "$(dirname "$0")")\necho new > "$v/value"\n[ ! -f "$TEST_ROOT/fail-pip" ] || [ "${v##*/}" != .venv-b ]\n')
            (v / 'value').write_text('old\n')
        self.git('add', '.')
        self.git('commit', '-m', 'old')
        self.old = self.git('rev-parse', 'HEAD')
        for n in ('a', 'b'):
            self.write(f'collectors/requirements-{n}.txt', 'new\n')
            self.write(f'collectors/{n}.py', '# new\n')
        self.git('add', '.')
        self.git('commit', '-m', 'new')
        self.git('tag', 'v1.0.0')
        self.new = self.git('rev-parse', 'HEAD')
        remote = self.root / 'remote.git'
        subprocess.run(['git', 'clone', '--bare', str(self.repo), str(remote)], check=True, capture_output=True)
        self.git('remote', 'add', 'origin', str(remote))
        self.git('reset', '--hard', self.old)
        self.executable(self.bin / 'sleep', '#!/bin/sh\nexit 0\n')
        self.executable(self.bin / 'systemctl', '''#!/bin/sh
echo "$*" >> "$TEST_ROOT/systemctl.log"
case "$*" in
  *"start --wait a.service"*) [ ! -f "$TEST_ROOT/fail-service" ] ;;
  *) exit 0 ;;
esac
''')

    def git(self, *args):
        return subprocess.run(['git', '-C', str(self.repo), *args], check=True,
                              capture_output=True, text=True).stdout.strip()

    def write(self, path, content):
        p = self.repo / path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)

    def executable(self, path, content):
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        path.chmod(0o755)

    def deploy(self):
        return subprocess.run(['bash', str(SCRIPT), 'deploy'], env=self.env,
                              capture_output=True, text=True, timeout=20)

    def result(self):
        return json.loads((self.state / 'deploy.json').read_text())['result']

    def test_second_dependency_failure_restores_all_environments_and_code(self):
        (self.root / 'fail-pip').touch()
        r = self.deploy()
        self.assertNotEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.old)
        for n in ('a', 'b'):
            self.assertEqual((self.repo / f'collectors/.venv-{n}/value').read_text(), 'old\n')
        self.assertEqual(self.result(), 'failed')
        (self.root / 'fail-pip').unlink()
        r = self.deploy()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.new)

    def test_failed_oneshot_is_rechecked_at_same_commit(self):
        (self.root / 'fail-service').touch()
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.new)
        self.assertNotEqual(self.deploy().returncode, 0)
        self.assertEqual(self.result(), 'failed')
        (self.root / 'fail-service').unlink()
        r = self.deploy()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(self.result(), 'ok')
        self.assertFalse((self.state / 'pending-base').exists())
        self.assertEqual((self.root / 'systemctl.log').read_text().count('start --wait a.service'), 3)

    def test_interrupted_dependency_update_blocks_automatic_success(self):
        (self.state / 'dependency-backup').mkdir(parents=True)
        r = self.deploy()
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.git('rev-parse', 'HEAD'), self.old)
        self.assertEqual(self.result(), 'failed')


if __name__ == '__main__':
    unittest.main()
