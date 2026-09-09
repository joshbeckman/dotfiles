if !exists('*AgentMailComposeDraft')
function! AgentMailComposeDraft() abort
    let draft = trim(system('agent-mail compose 2>&1'))
    if v:shell_error
        echoerr draft
        return
    endif
    execute 'tabedit ' . fnameescape(draft)
    call cursor(1, 1)
    call search('^To: ')
    normal! $
    startinsert!
endfunction
endif

let s:human_mail_root = resolve(fnamemodify(empty($AGENT_HUMAN_MAIL_ROOT) ? expand('~/.local/state/agent-mail/humans') : $AGENT_HUMAN_MAIL_ROOT, ':p'))
let s:josh_inbox = s:human_mail_root . '/josh/inbox'
let s:netrw_dir = resolve(fnamemodify(get(b:, 'netrw_curdir', expand('%:p')), ':p'))
if s:netrw_dir ==# s:josh_inbox
    command! -buffer AgentMailCompose call AgentMailComposeDraft()
    nnoremap <buffer> <silent> <nowait> <Leader>c :AgentMailCompose<CR>
endif
