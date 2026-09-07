command! -buffer Critique call CritiqueDraft()

if !exists('s:agent_mail_functions_loaded')
let s:agent_mail_functions_loaded = 1

function! s:AgentMailRun(args) abort
    let output = system('agent-mail ' . a:args . ' 2>&1')
    if v:shell_error
        echoerr trim(output)
        return ''
    endif
    return trim(output)
endfunction

function! s:AgentMailArchive() abort
    if &modified
        echoerr 'Save or discard changes before archiving this message'
        return
    endif
    let destination = s:AgentMailRun('archive ' . shellescape(expand('%:p')))
    if empty(destination)
        return
    endif
    execute 'file ' . fnameescape(destination)
    setlocal nomodified
    echo 'Archived to ' . destination
endfunction

function! s:AgentMailReply() abort
    let draft = s:AgentMailRun('reply ' . shellescape(expand('%:p')))
    if !empty(draft)
        execute 'tabedit ' . fnameescape(draft)
        normal! G
        startinsert
    endif
endfunction

function! s:AgentMailSend() abort
    write
    let destination = s:AgentMailRun('deliver ' . shellescape(expand('%:p')))
    if empty(destination)
        return
    endif
    echo 'Sent to ' . destination
    if tabpagenr('$') > 1
        tabclose
    else
        bdelete
    endif
endfunction

endif

let s:agent_mail_root = resolve(fnamemodify(empty($AGENT_MAIL_ROOT) ? '/tmp/agent' : $AGENT_MAIL_ROOT, ':p'))
let s:agent_mail_path = resolve(expand('%:p'))
if stridx(s:agent_mail_path, substitute(s:agent_mail_root, '/$', '', '') . '/') == 0
    if s:agent_mail_path =~# '/inbox/new/[^/]*\.md$'
        command! -buffer AgentMailArchive call <SID>AgentMailArchive()
        command! -buffer AgentMailReply call <SID>AgentMailReply()
    elseif s:agent_mail_path =~# '/inbox/cur/[^/]*\.md$'
        command! -buffer AgentMailReply call <SID>AgentMailReply()
    elseif s:agent_mail_path =~# '/humans/josh/drafts/[^/]*\.md$'
        command! -buffer AgentMailSend call <SID>AgentMailSend()
    endif
endif
