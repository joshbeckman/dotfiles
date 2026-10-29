#!/usr/bin/env python3
"""Conservative CI routing. Unknown paths or unavailable history run everything."""
import json
import os
from pathlib import Path
import subprocess


def git(*args):
    return subprocess.check_output(['git', *args], stderr=subprocess.PIPE)


def changed_paths(event_name, event):
    """Use the PR's branch delta, or the whole pushed range (not just HEAD^)."""
    if event_name == 'pull_request':
        base = event['pull_request']['base']['sha']
        head = event['pull_request']['head']['sha']
        base = git('merge-base', base, head).decode().strip()
    elif event_name == 'push':
        base, head = event['before'], event['after']
        if not base.strip('0') or not head.strip('0'):
            raise ValueError('new/deleted branch has no comparable range')
    else:
        raise ValueError('full-run event')
    # Disabling rename detection exposes both the removed and added paths. A move
    # across suite boundaries must exercise both sides, including deletions.
    return [os.fsdecode(p) for p in git(
        'diff', '--no-renames', '--name-only', '-z', base, head, '--'
    ).split(b'\0') if p]


def select(paths):
    if not paths:
        return {'repo': True, 'skills': False, 'pana': True}, 'empty diff: full coverage'
    skills = pana = False
    for path in paths:
        if path.startswith('.agents/skills/') and path.endswith('.md'):
            skills = True
        elif path.startswith('pana/'):
            pana = True
        else:
            return {'repo': True, 'skills': False, 'pana': True}, 'unknown/shared path: ' + repr(path)
    return {'repo': False, 'skills': skills, 'pana': pana}, 'known boundaries only'


def main():
    try:
        event = json.loads(Path(os.environ['GITHUB_EVENT_PATH']).read_text())
        paths = changed_paths(os.environ['GITHUB_EVENT_NAME'], event)
        suites, reason = select(paths)
    except (KeyError, ValueError, OSError, subprocess.CalledProcessError) as error:
        suites = {'repo': True, 'skills': False, 'pana': True}
        reason = f'full coverage: {error}'
    # Preserve support for branches predating pana (or removing it).
    suites['pana'] = suites['pana'] and Path('pana/package.json').is_file()
    print(reason)
    output = ''.join(f'{name}={str(run).lower()}\n' for name, run in suites.items())
    print(output, end='')
    with open(os.environ['GITHUB_OUTPUT'], 'a') as stream:
        stream.write(output)


if __name__ == '__main__':
    main()
