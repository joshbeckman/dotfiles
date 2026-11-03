# Shared, read-only provider routing and Delta operations for the git-pr helpers.
require 'json'
require 'open3'
require 'uri'

module PRLookup
  module_function

  def capture(*args)
    out, status = Open3.capture2(*args)
    raise "#{args.first} failed (exit #{status.exitstatus})" unless status.success?
    out.strip
  rescue Errno::ENOENT
    raise "#{args.first} is required for this repository"
  end

  def git_optional(*args)
    out, err, status = Open3.capture3('git', *args)
    warn err unless err.empty? || !status.success?
    status.success? ? out.strip : ''
  end

  def config(key)
    git_optional('config', '--local', '--get', key)
  end

  def repository(url)
    url = "ssh://#{url.sub(':', '/')}" if url.match?(/\A[^\/:]+@[^\/:]+:/)
    uri = URI.parse(url)
    path = uri.path.to_s.sub(%r{\A/}, '').sub(/\.git\z/, '')
    raise 'remote must identify a host and OWNER/REPO' unless uri.host && path.match?(%r{\A[^/]+/[^/]+\z})
    # HTTPS is the browser/API transport even when the Git remote uses SSH.
    ["https://#{uri.host}#{uri.port && ![22, 80, 443].include?(uri.port) ? ":#{uri.port}" : ''}", path]
  end

  def route(selector)
    if selector.start_with?('http://', 'https://') && URI.parse(selector).host == 'github.com'
      return ['github', '-', '-']
    end
    provider = config('prLookup.provider')
    provider = 'delta' if provider == 'dt'
    raise "unsupported provider: #{provider}" unless ['', 'github', 'gitstream', 'delta'].include?(provider)
    remote = config('prLookup.remote')
    configured_remote = !remote.empty?
    remote = 'origin' if remote.empty?
    remote_url = git_optional('remote', 'get-url', remote)
    raise "configured PR remote does not exist: #{remote}" if configured_remote && remote_url.empty?
    hosted_remote = remote_url.match?(%r{\A(?:https?://|ssh://|[^/\s:]+@[^/\s:]+:)})
    host, repo = hosted_remote ? repository(remote_url) : ['', '']
    explicit_host, explicit_repo = config('prLookup.host'), config('prLookup.repo')
    host = explicit_host.sub(%r{/+\z}, '') unless explicit_host.empty?
    host = "https://#{host}" unless host.empty? || host.include?('://')
    repo = explicit_repo unless explicit_repo.empty?
    # A non-GitHub origin must be positively identified, never routed to its mirror.
    template = config('prLookup.urlTemplate')
    template = config('prForCommit.urlTemplate') if template.empty?
    legacy_host = provider == 'gitstream' && ((!explicit_host.empty? && !explicit_repo.empty?) || (!template.empty? && !host.empty? && URI.parse(template.gsub('{number}', '1')).host == URI.parse(host).host))
    discover = hosted_remote && URI.parse(host).host != 'github.com' && provider != 'github' && !legacy_host
    selected_host = host
    if provider == 'delta' || discover
      raise 'configure prLookup.host and prLookup.repo or a repository remote' if host.empty? || repo.empty?
      raise 'prLookup.repo must be OWNER/REPO' unless repo.match?(%r{\A[^/\s]+/[^/\s]+\z})
      info = JSON.parse(capture('dt', '--host', host, '-R', repo, 'repo', 'view', '--json'))
      raise 'Delta repository discovery returned a different repository' unless info.fetch('full_name') == repo
      canonical_host, canonical_repo = repository(info.fetch('html_url'))
      raise 'Delta repository URL returned a different repository' unless canonical_repo == repo
      host = canonical_host
      provider = 'delta'
    end
    provider = 'github' if provider.empty?
    if selector.start_with?('http://', 'https://')
      uri = URI.parse(selector)
      if provider == 'delta'
        allowed_hosts = [host, selected_host].map { |h| URI.parse(h) }
        direct = allowed_hosts.any? { |h| uri.host == h.host && uri.port == h.port } && uri.path.match?(%r{\A/#{Regexp.escape(repo)}/pull/[0-9]+/?\z})
        raise 'PR URL does not match the selected Delta host/repository' unless direct || template_matches?(selector)
      elsif provider == 'gitstream'
        template = config('prLookup.urlTemplate')
        template = config('prForCommit.urlTemplate') if template.empty?
        trusted = !explicit_host.empty? && !explicit_repo.empty? && uri.host == URI.parse(host).host && uri.port == URI.parse(host).port
        direct = trusted && uri.path.match?(%r{\A/(?:repos/)?#{Regexp.escape(repo)}/pulls/[0-9]+/?\z})
        valid = direct || template_matches?(selector)
        raise 'PR URL does not match the configured Gitstream host' unless valid
      else
        raise 'unknown PR URL host; configure prLookup.provider and repository routing'
      end
    end
    [provider, host.empty? ? '-' : host, repo.empty? ? '-' : repo]
  end

  def template_matches?(selector)
    template = config('prLookup.urlTemplate')
    template = config('prForCommit.urlTemplate') if template.empty?
    return false unless template.include?('{number}')
    clean = URI.parse(selector)
    clean.query = clean.fragment = nil
    pattern = Regexp.escape(template).sub(Regexp.escape('{number}'), '[0-9]+')
    clean.to_s.match?(Regexp.new("\\A#{pattern}/?\\z"))
  end

  class Delta
    def initialize(host, repo)
      @host, @repo = host, repo
    end

    def args(*args)
      ['dt', '--host', @host, '-R', @repo, *args]
    end

    def json(*command)
      JSON.parse(PRLookup.capture(*args(*command)))
    end

    def number(selector)
      return selector if selector.match?(/\A[0-9]+\z/)
      return URI.parse(selector).path.split('/').reject(&:empty?).last if selector.start_with?('http://', 'https://')
      branch = selector.empty? ? PRLookup.git_optional('branch', '--show-current') : selector
      raise 'cannot infer a branch from detached HEAD' if branch.empty?
      list = json('pr', 'list', '--head', branch, '--state', 'all', '--limit', '2', '--json')
      raise "expected one pull request for branch #{branch}, found #{list.length}" unless list.length == 1
      list.first.fetch('number').to_s
    end

    def url(number)
      "#{@host}/#{@repo}/pull/#{number}"
    end

    def lookup(mode, selector, required)
      n = number(selector)
      raise 'invalid PR number returned by provider' unless n.match?(/\A[0-9]+\z/)
      case mode
      when 'url'
        pr = json('pr', 'view', n, '--json') # Verify existence, not just URL syntax.
        raise 'Delta returned a different PR number' unless pr.fetch('number').to_s == n
        puts url(n)
      when 'view'
        exec(*args('pr', 'view', n, '--comments'))
      when 'merged'
        pr = json('pr', 'view', n, '--json')
        raise 'Delta returned a different PR number' unless pr.fetch('number').to_s == n
        raise 'not merged' unless pr['merged'] == true && !pr['merged_at'].to_s.empty?
        puts pr.fetch('merged_at')
      when 'checks'
        exec(*args('pr', 'checks', n)) unless required == 'true'
        readiness = json('api', "pulls/#{n}/merge-readiness")
        checks = readiness.fetch('status_check_rollup').fetch('contexts').select { |c| c.fetch('required') }
        puts '| Check | Status | Result |', '| --- | --- | --- |'
        failed = pending = false
        checks.each do |c|
          state = c['conclusion'] || c.fetch('status')
          state = 'missing' if c['present'] == false
          puts "| #{c.fetch('name').gsub('|', '\\|')} | #{state} | #{c['present'] == false ? 'Missing' : 'Required'} |"
          if c['present'] == false || %w[pending queued in_progress waiting requested].include?(state)
            pending = true
          elsif !%w[success neutral skipped].include?(state)
            failed = true
          end
        end
        exit(failed ? 1 : pending ? 8 : 0)
      end
    end

    def associated?(pr, commit)
      return true if [pr.dig('head', 'sha'), pr['merge_commit_sha']].include?(commit)
      page = 1
      seen_pages = []
      loop do
        raise 'too many PR commit pages; association is incomplete' if page > 100
        commits = json('api', "pulls/#{pr.fetch('number')}/commits?per_page=100&page=#{page}")
        raise 'invalid PR commits response' unless commits.is_a?(Array)
        shas = commits.map { |c| c.fetch('sha') }
        raise 'repeated PR commit page; association is incomplete' if seen_pages.include?(shas)
        seen_pages << shas
        return true if commits.any? { |c| c.fetch('sha') == commit }
        return false if commits.length < 100
        page += 1
      end
    end

    def for_commit(commit)
      # Commit text and containing branches supply candidates, never proof. Always
      # verify exact commit IDs against Delta before returning a canonical URL.
      candidates = []
      refs = PRLookup.capture('git', 'for-each-ref', '--format=%(refname)', '--contains', commit, 'refs/heads').lines.map(&:strip)
      base = PRLookup.config('prLookup.baseRef')
      base = PRLookup.config('prForCommit.baseRef') if base.empty?
      base = PRLookup.git_optional('symbolic-ref', '--short', 'refs/remotes/origin/HEAD') if base.empty?
      commits = [commit]
      unless base.empty?
        PRLookup.capture('git', 'rev-parse', '--verify', "#{base}^{commit}")
        commits += PRLookup.capture('git', 'rev-list', '--ancestry-path', '--merges', '--reverse', "#{commit}..#{base}").lines.map(&:strip).reject(&:empty?)
      end
      trailer = PRLookup.config('prLookup.trailer')
      trailer = PRLookup.config('prForCommit.trailer') if trailer.empty?
      commits.each do |sha|
        text = PRLookup.capture('git', 'show', '-s', '--format=%B', sha)
        candidates += text.lines.first.to_s.scan(/\(#([0-9]+)\)/).flatten
        candidates += text.scan(/^#{Regexp.escape(trailer)}:\s*([0-9]+)\s*$/).flatten unless trailer.empty?
        candidates += text.scan(%r{#{Regexp.escape(@host)}/#{Regexp.escape(@repo)}/pull/([0-9]+)}).flatten
      end
      refs.each do |ref|
        branch = ref.sub('refs/heads/', '')
        prs = json('pr', 'list', '--head', branch, '--state', 'all', '--limit', '100', '--json')
        raise "too many PR candidates for branch #{branch}; narrow repository history" if prs.length >= 100
        candidates += prs.map { |pr| pr.fetch('number').to_s }
      end
      matches = candidates.uniq.select do |n|
        pr = json('pr', 'view', n, '--json')
        raise 'Delta returned a different PR number' unless pr.fetch('number').to_s == n
        associated?(pr, commit)
      end
      raise "no verified Delta pull request found for #{commit}; candidates require a containing local branch, PR subject/link, or configured trailer" if matches.empty?
      raise "multiple Delta pull requests found for #{commit}: #{matches.join(', ')}" unless matches.length == 1
      puts url(matches.first)
    end
  end
end

if $PROGRAM_NAME == __FILE__
  begin
    action = ARGV.shift
    case action
    when 'route' then puts PRLookup.route(ARGV.fetch(0, '')).join("\t")
    when 'lookup' then PRLookup::Delta.new(ARGV.shift, ARGV.shift).lookup(*ARGV)
    when 'commit' then PRLookup::Delta.new(ARGV.shift, ARGV.shift).for_commit(ARGV.fetch(0))
    else raise 'unknown PR routing operation'
    end
  rescue StandardError => e
    warn "git pr: #{e.message}"
    exit 1
  end
end
