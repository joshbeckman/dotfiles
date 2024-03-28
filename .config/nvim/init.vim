
syntax enable
syntax on
filetype plugin indent on
set tabstop=8 softtabstop=0 expandtab shiftwidth=4 smarttab
imap kj <Esc>
let mapleader = "\<Space>"

"""""""    themes and schemes
" to set up solarized light theme
" (my old reliable workhorse)
" set background=light
" colorscheme solarized
"
" to set up nord (dark) theme
" (my favorite for dark rooms and winter months)
" colorscheme nord

" to set up papercolor light theme
" (my favorite for bright rooms and summer months)
set background=light

" Use tab and shift-tab to cycle through tabs
nnoremap <Tab> :tabn<CR>
nnoremap <S-Tab> :tabp<CR>

" Special leader-based conveniences
nnoremap <Leader>cn :cnext<CR>
nnoremap <Leader>cp :cprevious<CR>
" copy current file name (including path)
nnoremap <Leader>cf :let @*=expand("%:p")<CR>
nnoremap <Leader>dt :pu=strftime('%Y-%m-%dT%H:%M:%S')<CR>
nnoremap <Leader>b :vnew <C-r>=escape(expand("%:p:h"), ' ') . '/'<cr>
nnoremap <Leader>e :find 
nnoremap <Leader>o :tabf 
nnoremap <Leader>v :vert sf 
nnoremap <Leader>h :sf 
nnoremap <Leader>f :tabnew<CR>:FZF<CR>
nnoremap <Leader>g :grep -r --include='*.<C-R>=expand('%:e')<CR>' '<C-R><C-W>' ./<CR><CR>:cw<CR>
" search for visually-selected text with '//'
vnoremap // y/\V<C-R>=escape(@",'/\')<CR><CR>
nnoremap <Leader>t <C-w><C-]><C-w>T
nnoremap <Leader>ld :LspDefinition<CR>
nnoremap <Leader>nn :set nonumber norelativenumber<CR>
nnoremap <Leader>p :set paste<CR><esc>"*]p:set nopaste<cr>"
nnoremap <Leader>q :q<CR>
nnoremap <Leader>w :w<CR>
map <silent> <Leader>cop :call RubocopAutocorrect()<cr>
map <silent> <Leader>eslint :call EslintAutocorrect()<cr>
map <silent> <leader>aj :ALENext<cr>
map <silent> <leader>ak :ALEPrevious<cr>
" Move around splits with <c-hjkl>
nnoremap <c-j> <c-w>j
nnoremap <c-k> <c-w>k
nnoremap <c-h> <c-w>h
nnoremap <c-l> <c-w>l

set backspace=indent,eol,start  " more powerful backspacing
set autowrite
set autoindent
set incsearch
set hlsearch
set ignorecase smartcase
set signcolumn=yes
" show trailing characters for e.g. spaces
set list
set listchars=tab:$\ ,trail:·
" don't need to show INSERT/etc. status line
set noshowmode
" start scrolling before I get to the edge
set scrolloff=8
set sidescrolloff=8
" Split things into the side
set splitbelow
set splitright

" Make highlighting consistent across color schemes
hi Search ctermbg=Yellow
hi Search ctermfg=Black

" Colors for the gutter / sign column
hi clear SignColumn
highlight GitGutterAdd    guifg=#009900 ctermfg=2
highlight GitGutterChange guifg=#bbbb00 ctermfg=3
highlight GitGutterDelete guifg=#ff2222 ctermfg=1

hi Visual cterm=reverse
set clipboard=unnamed
highlight OverLength ctermbg=blue ctermfg=white
" for tablilne colors
hi TabLineFill term=bold cterm=bold ctermbg=0

" Custom commands
command! -complete=shellcmd -nargs=+ Sh new | 0read ! "<args>"

" Support for infinite undo!
set undofile
set undodir=~/.vim/undodir
" Delete undo records over 90 days old
let s:undos = split(globpath(&undodir, '*'), "\n")
call filter(s:undos, 'getftime(v:val) < localtime() - (60 * 60 * 24 * 90)')
call map(s:undos, 'delete(v:val)')

" auto-reload a file if it changes outside of vim
set autoread
" Have Vim jump to the last position when reopening a file
if has("autocmd")
    au BufReadPost * if line("'\"") > 1 && line("'\"") <= line("$") | exe "normal! g'\"" | endif
endif
" Per default, netrw leaves unmodified buffers open. This autocommand
" deletes netrw's buffer once it's hidden (using ':q', for example)
autocmd FileType netrw setl bufhidden=delete
" navigate to previous tab when closing a tab
autocmd TabClosed * tabprevious

" configure fuzzy-finder
set rtp+=/opt/homebrew/opt/fzf

" configure ripgrep for faster grepping
set grepprg=rg\ --vimgrep
set grepformat^=%f:%l:%c:%m

" include tags files in completion list
set complete+=t
" change the 'completeopt' option so that Vim's popup menu doesn't select the
" first completion item, but rather just inserts the longest common text of
" all matches; and the menu will come up if there's more than one match.
set completeopt=longest,menu

" autocompletion
set omnifunc=syntaxcomplete#Complete

" let :tabfind (:tabf) search in pwd, current file directory, recursive
set path=.,,**

" Display all matching files when we tab complete
set wildmenu
set wildmode=longest,list

" disable folding
set foldmethod=manual
set nofoldenable

set tags=.git/tags,tags;$HOME

" FILE BROWSING:
" Tweaks for browsing:
let g:netrw_banner=0        " disable annoying banner
let g:netrw_altv=1          " open splits to the right
let g:netrw_liststyle=3     " tree view
let g:netrw_winsize=75      " sets the width to 75% of the page.
" let g:netrw_browse_split=2  " open files in a new vertical split

" :help ale-options
let g:ale_lint_on_enter = 1
let g:ale_lint_on_save = 1
let g:ale_linters = {}
let g:ale_linters['javascript'] = ['eslint']
let g:ale_linters['ruby'] = ['rubocop', 'sorbet', 'solargraph']
let g:ale_fixers = {}
let g:ale_fixers['javascript'] = ['prettier']
let g:ale_fixers['ruby'] = ['rubocop']

" hi clear StatusLine
" hi clear StatusLineNC
" hi clear SignColumn
" hi LineNr ctermfg=grey
" hi StatusLine   term=bold cterm=bold ctermfg=White
" hi StatusLineNC term=bold cterm=bold ctermfg=White
" hi User1                      ctermfg=4          guifg=#40ffff            " Identifier
" hi User2                      ctermfg=2 gui=bold guifg=#ffff60            " Statement
" hi User3 term=bold cterm=bold ctermfg=1          guifg=White   guibg=Red  " Error
" hi User4                      ctermfg=1          guifg=Orange             " Special
" hi User5                      ctermfg=10         guifg=#80a0ff            " Comment
" hi User6 term=bold cterm=bold ctermfg=1          guifg=Red                " WarningMsg
" set laststatus=2                                " always show statusline"
" set statusline=
" set statusline+=%6*%m%r%*                          " modified, readonly
" set statusline+=\ 
" set statusline+=%7*%{expand('%:h')}/               " relative path to file's directory
" set statusline+=%5*%t%*                            " file name
" set statusline+=\ 
" set statusline+=\ 
" set statusline+=%<                                 " truncate here if needed
" set statusline+=%5*%L\ lines%*                     " number of lines
" 
" set statusline+=%=                                 " switch to RHS
" 
" set statusline+=%5*line:%-4.l%*                         " line
" set statusline+=%5*col:%-3.c%*                          " column
" set statusline+=\ 
" set statusline+=\ 
" set statusline+=%1*buf:%-3n%*                      " buffer number

function! RubocopAutocorrect()
  execute "!rubocop -a " . bufname("%")
  :e
endfunction
function! EslintAutocorrect()
  execute "!eslint --fix " . bufname("%")
  :e
endfunction

" Language specifics
autocmd FileType css set tabstop=8 shiftwidth=2
autocmd FileType javascript match OverLength /\%121v.\+/
autocmd FileType php match OverLength /\%121v.\+/
autocmd FileType ruby match OverLength /\%121v.\+/
autocmd FileType ruby set tabstop=8 shiftwidth=2
autocmd FileType ruby,eruby,yaml setlocal iskeyword+=?
autocmd FileType ruby,eruby,yaml setlocal iskeyword+=!
au BufRead,BufNewFile *.html.arb set filetype=ruby
au BufRead,BufNewFile *.go set filetype=go 
au BufRead,BufNewFile *.handler set filetype=javascript 
" spellchecking in prose
autocmd BufRead,BufNewFile *.md setlocal spell
autocmd BufRead,BufNewFile *.txt setlocal spell
autocmd FileType gitcommit setlocal spell
" markdown helpers
nnoremap <Leader>3 "xciw[<C-r>x]()<Esc>
vnoremap <Leader>3 "xc[<C-r>x]()<Esc>
nnoremap <Leader>4 "xciw[<C-r>"x(<Esc>"*pli)<Esc>
vnoremap <Leader>4 "xc[<C-r>x](<Esc>"*pli)<Esc>
