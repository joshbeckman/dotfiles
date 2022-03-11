execute pathogen#infect()

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
colorscheme PaperColor

set backspace=indent,eol,start  " more powerful backspacing
set autowrite
set autoindent
set incsearch
set hlsearch
set ignorecase smartcase
set list
set listchars=tab:$\ ,trail:·
set noshowmode
set scrolloff=8
set sidescrolloff=8
set signcolumn=yes
set splitbelow
set splitright
hi Search ctermbg=LightYellow
" hi Search ctermfg=Red
set clipboard=unnamed
" set textwidth=80
" set colorcolumn=+1
highlight OverLength ctermbg=blue ctermfg=white

" Support for infinite undo!
set undofile
set undodir=~/.vim/undodir
" Delete undo records over 90 days old
let s:undos = split(globpath(&undodir, '*'), "\n")
call filter(s:undos, 'getftime(v:val) < localtime() - (60 * 60 * 24 * 90)')
call map(s:undos, 'delete(v:val)')

" auto-reload a file if it changes outside of vim
set autoread
" True color mode! (Requires a fancy modern terminal, but iTerm works.)
" :set termguicolors

" configure fuzzy-finder
set rtp+=/usr/local/opt/fzf

" configure ripgrep for faster grepping
set grepprg=rg\ --vimgrep
set grepformat^=%f:%l:%c:%m

" include tags files in completion list
set complete+=t
" change the 'completeopt' option so that Vim's popup menu doesn't select the
" first completion item, but rather just inserts the longest common text of
" all matches; and the menu will come up even if there's only one match.
set completeopt=longest,menuone,preview

" autocompletion
set omnifunc=syntaxcomplete#Complete

" let :tabfind (:tabf) search in pwd, current file directory, recursive
set path=.,,**

" Display all matching files when we tab complete
set wildmenu
set wildmode=longest,list

set foldmethod=manual
set nofoldenable        " disable folding

set tags=.git/tags,tags;$HOME

" allow gf to open new files
map gf :edit <cfile><CR>

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
" Move around splits with <c-hjkl>
nnoremap <c-j> <c-w>j
nnoremap <c-k> <c-w>k
nnoremap <c-h> <c-w>h
nnoremap <c-l> <c-w>l

" Custom commands
command! -complete=shellcmd -nargs=+ Sh new | 0read ! "<args>"

" for tablilne colors
hi TabLineFill term=bold cterm=bold ctermbg=0

" For LimeLight config
let g:limelight_conceal_ctermfg = 'white'
let g:limelight_conceal_ctermfg = 240

" using airline themed statusline
" git clone https://github.com/vim-airline/vim-airline ~/.vim/bundle/vim-airline
" git clone https://github.com/vim-airline/vim-airline-themes ~/.vim/bundle/vim-airline-themes
let g:airline_theme='papercolor'

" for old, pre-airline, custom statusline
" https://github.com/airblade/dotvim/blob/dd5d7737e39aad5e24c1a4a8c0d115ff2ae7b488/vimrc#L49-L91
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

" spellchecking in prose
autocmd BufRead,BufNewFile *.md setlocal spell
autocmd BufRead,BufNewFile *.txt setlocal spell
autocmd FileType gitcommit setlocal spell

" linewrap in prose
" autocmd BufRead,BufNewFile *.md setlocal textwidth=80

" :help ale-options
let g:ale_lint_on_enter = 1
let g:ale_lint_on_save = 1
let g:ale_linters = {}
let g:ale_linters['javascript'] = ['eslint']
let g:ale_linters['ruby'] = ['rubocop', 'sorbet', 'solargraph']
let g:ale_fixers = {}
let g:ale_fixers['javascript'] = ['prettier']
let g:ale_fixers['ruby'] = ['rubocop']

" configuration for vim-lsp
if executable('solargraph')
    " gem install solargraph
    au User lsp_setup call lsp#register_server({
        \ 'name': 'solargraph',
        \ 'cmd': {server_info->[&shell, &shellcmdflag, 'solargraph stdio']},
        \ 'initialization_options': {"diagnostics": "true"},
        \ 'whitelist': ['ruby'],
        \ })
endif
if executable('flow')
    au User lsp_setup call lsp#register_server({
        \ 'name': 'flow',
        \ 'cmd': {server_info->['flow', 'lsp']},
        \ 'root_uri':{server_info->lsp#utils#path_to_uri(lsp#utils#find_nearest_parent_file_directory(lsp#utils#get_buffer_path(), '.flowconfig'))},
        \ 'whitelist': ['javascript', 'javascript.jsx'],
        \ })
endif

" FILE BROWSING:
" Tweaks for browsing:
let g:netrw_banner=0        " disable annoying banner
let g:netrw_altv=1          " open splits to the right
let g:netrw_liststyle=3     " tree view
let g:netrw_winsize=75      " sets the width to 75% of the page.
" let g:netrw_browse_split=2  " open files in a new vertical split

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

" CompleteJS autocompletion
autocmd FileType javascript set omnifunc=javascriptcomplete#CompleteJS

" Per default, netrw leaves unmodified buffers open. This autocommand
" deletes netrw's buffer once it's hidden (using ':q', for example)
autocmd FileType netrw setl bufhidden=delete

au VimEnter * RainbowParenthesesToggle
au Syntax * RainbowParenthesesLoadRound
au Syntax * RainbowParenthesesLoadSquare
au Syntax * RainbowParenthesesLoadBraces

" Uncomment the following to have Vim jump to the last position when
" reopening a file
if has("autocmd")
    au BufReadPost * if line("'\"") > 1 && line("'\"") <= line("$") | exe "normal! g'\"" | endif
endif

function! RubocopAutocorrect()
  execute "!rubocop -a " . bufname("%")
  :e
endfunction
function! EslintAutocorrect()
  execute "!eslint --fix " . bufname("%")
  :e
endfunction
map <silent> <Leader>cop :call RubocopAutocorrect()<cr>
map <silent> <Leader>eslint :call EslintAutocorrect()<cr>
map <silent> <leader>aj :ALENext<cr>
map <silent> <leader>ak :ALEPrevious<cr>

""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""
" MULTIPURPOSE TAB KEY
" Indent if we're at the beginning of a line. Else, do completion.
""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""
" function! InsertTabWrapper()
"     let col = col('.') - 1
"     if !col
"         return "\<tab>"
"     endif
" 
"     let char = getline('.')[col - 1]
"     if char =~ '\k'
"         " There's an identifier before the cursor, so complete the identifier.
"         return "\<c-p>"
"     else
"         return "\<tab>"
"     endif
" endfunction
" inoremap <expr> <tab> InsertTabWrapper()
" inoremap <s-tab> <c-n>

" include matching macros for languages e.g. Ruby
" (So you can select inside a method with `vim`)
runtime macros/matchit.vim

""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""
" Control text popups, courtesy of https://github.com/EdwardGallant
""""""""""""""""""""""""""""""""""""""""""""""""""""""""""""
" open a popup with custom text at the cursor
" (will close automatically when the cursor moves)
fu! TextInPopupAtCursor( title, text, ft ) " text can be an array or string
    " it would be nice to save the filepath as well for quick navigation if
    " the buffer is too large... I cant get scrolling to work with popups,
    " although scrolling works fine with splits and generally outside popups
    let eg_popup_id = popup_atcursor(a:text, {'title': ' '.a:title.' ', 'padding': [1,1,1,1], 'pos':'topleft', 'border':[1,1,1,1], 'scrollbar': 1})
    call setbufvar( winbufnr(eg_popup_id), '&filetype', a:ft)
endfu

" open a popup in the top right of the buffer, kind of like minimap
fu! TopRightPopup( title, text, ft ) " text can be an array or string
    let g:top_right_popup = popup_create(
                \ a:text,
                \ { 'title': ' '.a:title.' '
                \ , 'padding': [1,1,1,1]
                \ , 'line': 1
                \ , 'col': &columns
                \ , 'pos':'topright'
                \ , 'border':[1,1,1,1]
                \ , 'scrollbar': 1 })
    call setbufvar( winbufnr(g:top_right_popup), '&filetype', a:ft)
endfu
fu! CloseTopRightPopup()
    if exists('g:top_right_popup')
        call popup_close( g:top_right_popup )
    endif
endfu
