#!/usr/bin/env ruby
# frozen_string_literal: true

# Record one GitHub issue or pull request into an evaluation fixture.
#
#   ruby model-eval/capture.rb FIXTURE_ID KIND URL
#
# KIND is `issue` or `pull`. The script writes gzipped snapshots into
# model-eval/fixtures/FIXTURE_ID/snapshot/, which the trial cannot read: the harness passes the
# directory to the stub CLI by path. It installs that CLI as workspace/bin/gh and workspace/bin/gw
# and records provenance in snapshot/snapshot.json. Re-running replaces the snapshot; commit the
# result so fixture versions stay stable.

require "digest"
require "fileutils"
require "json"
require "time"
require "zlib"

ROOT = File.expand_path("..", __dir__)
CLI = File.join(__dir__, "snapshot-cli.rb")
PR_FIELDS = %w[number title url state mergedAt createdAt author body comments reviews files commits
               additions deletions labels baseRefName headRefName].freeze
ISSUE_FIELDS = %w[number title url state createdAt author body comments labels].freeze

def run(*command)
  output = IO.popen(command, err: File::NULL, &:read)
  raise "command failed: #{command.join(" ")}" unless $?.success? && !output.empty?
  output
end

def number_from(url)
  url[%r{/(\d+)\z}, 1] or raise "cannot read a number from #{url}"
end

def write_gzip(path, content)
  FileUtils.mkdir_p(File.dirname(path))
  Zlib::GzipWriter.open(path) { |gz| gz.write(content) }
end

fixture_id, kind, url = ARGV
raise "usage: capture.rb FIXTURE_ID issue|pull URL" unless fixture_id && %w[issue pull].include?(kind) && url

fixture = File.join(ROOT, "model-eval", "fixtures", fixture_id)
snapshot = File.join(fixture, "snapshot")
number = number_from(url)

files = {}
files["view-md.md"] = run("gh", "view-md", url)
files["view-md-trimmed.md"] = run("gh", "view-md", "--max-diff", "0", url)
files["diff.patch"] = run("gh", "pr", "diff", url) if kind == "pull"

if kind == "pull"
  files["pr.json"] = run("gh", "pr", "view", url, "--json", PR_FIELDS.join(",")) + "\n"
  files["review-comments.json"] = begin
    run("gh", "api", "repos/#{url[%r{github\.com/([^/]+/[^/]+)/}, 1]}/pulls/#{number}/comments") + "\n"
  rescue StandardError
    "[]\n"
  end
else
  files["issue.json"] = run("gh", "issue", "view", url, "--json", ISSUE_FIELDS.join(",")) + "\n"
end

FileUtils.rm_rf(snapshot)
files.each { |name, content| write_gzip(File.join(snapshot, "#{name}.gz"), content) }

bin = File.join(fixture, "workspace", "bin")
FileUtils.mkdir_p(bin)
FileUtils.cp(CLI, File.join(bin, "cli.rb"))
FileUtils.chmod(0o644, File.join(bin, "cli.rb"))
%w[gh gw].each do |name|
  target = File.join(bin, name)
  File.write(target, "#!/bin/sh\nexec ruby \"$(dirname \"$0\")/cli.rb\" --as #{name} \"$@\"\n")
  FileUtils.chmod(0o755, target)
end

metadata = {
  "id" => fixture_id, "kind" => kind, "source_url" => url,
  "captured_at" => Time.now.utc.iso8601, "cli_sha256" => Digest::SHA256.file(CLI).hexdigest,
  "sizes" => files.transform_values(&:bytesize)
}
File.write(File.join(snapshot, "snapshot.json"), JSON.pretty_generate(metadata) + "\n")

# The `removed` variant is the same machine with no view-md extension installed: every record
# except the view-md ones, which is what an uninstalled extension can honestly serve.
variant = File.join(fixture, "snapshot-removed")
FileUtils.rm_rf(variant)
FileUtils.mkdir_p(variant)
files.each_key do |name|
  next if name.start_with?("view-md")
  # Relative so the link survives a clone; an absolute one would dangle on any other machine.
  File.symlink(File.join("..", "snapshot", "#{name}.gz"), File.join(variant, "#{name}.gz"))
end
File.write(File.join(variant, "snapshot.json"), JSON.pretty_generate(metadata.merge("viewmd" => "absent")) + "\n")

metadata.fetch("sizes").each { |name, size| puts format("%-22s %8d", name, size) }
puts format("%-22s %8d", "total", metadata.fetch("sizes").values.sum)
