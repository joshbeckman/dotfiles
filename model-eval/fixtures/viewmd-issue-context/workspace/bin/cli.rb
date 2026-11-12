#!/usr/bin/env ruby
# frozen_string_literal: true

# Offline stand-in for `gh` and `gw` inside a view-md evaluation fixture.
#
# The evaluation harness denies network access, so each fixture carries a snapshot of one real
# GitHub issue or pull request. This script serves that snapshot under the same command shapes the
# live tools have, so a trial reads the same content a real session would read:
#
#   bin/gh pr view <n|url> [--json FIELDS] [--jq EXPR]
#   bin/gh pr diff <n|url>
#   bin/gh issue view <n|url> [--json FIELDS] [--jq EXPR]
#   bin/gh api repos/OWNER/REPO/pulls/N/comments
#   bin/gw view-md <n|url> [--max-diff LINES]
#
# `PI_EVAL_VIEWMD=removed` makes the view-md path fail the way an uninstalled extension does.
# Every call appends a row to `.calls.tsv` in the workspace so byte volume is measurable.

require "json"
require "zlib"

ROOT = ENV.fetch("PI_EVAL_ROOT") { Dir.pwd }
SNAPSHOT = ENV.fetch("SNAPSHOT_DIR") { File.join(ROOT, ".snapshot") }
CALLS = File.join(ROOT, ".calls.tsv")

def fail_with(message, status: 1)
  warn message
  exit status
end

def snapshot?(name)
  File.file?(File.join(SNAPSHOT, "#{name}.gz"))
end

def read_snapshot(name)
  path = File.join(SNAPSHOT, "#{name}.gz")
  fail_with("snapshot missing: #{File.basename(path)}") unless File.file?(path)
  Zlib.gunzip(File.binread(path))
end

def record(args, bytes)
  File.open(CALLS, "a") { |file| file.puts(["gh", *args, bytes].join("\t")) }
rescue SystemCallError
  nil
end

def emit(text, args)
  record(args, text.bytesize)
  $stdout.write(text)
end

def jq(value, expression)
  IO.popen(["jq", "-c", expression], "r+") do |io|
    io.write(value)
    io.close_write
    io.read
  end
rescue SystemCallError
  fail_with("jq is unavailable")
end

def fields(args)
  index = args.index { |arg| arg == "--json" || arg.start_with?("--json=") }
  return nil unless index
  value = args[index] == "--json" ? args[index + 1] : args[index].split("=", 2).last
  value.to_s.split(",").map(&:strip).reject(&:empty?)
end

def jq_expression(args)
  index = args.index { |arg| arg == "--jq" || arg.start_with?("--jq=") }
  return nil unless index
  args[index] == "--jq" ? args[index + 1] : args[index].split("=", 2).last
end

def finish(value, args)
  text = JSON.pretty_generate(value) + "\n"
  expression = jq_expression(args)
  text = jq(text, expression) if expression
  emit(text, args)
end

def plain_view(document, args)
  text = +""
  text << "#{document["title"]}\n\n"
  text << "#{document["state"]}\n\n" if document["state"]
  text << document["body"].to_s << "\n"
  Array(document["comments"]).each do |comment|
    text << "\n---\n\n**@#{comment.dig("author", "login") || "unknown"}** commented:\n\n"
    text << comment["body"].to_s << "\n"
  end
  emit(text, args)
end

def json_view(snapshot_name, args)
  document = JSON.parse(read_snapshot(snapshot_name))
  wanted = fields(args)
  unless wanted
    plain_view(document, args)
    return
  end
  unknown = wanted - document.keys
  fail_with("Unknown JSON field: #{unknown.first}") unless unknown.empty?
  finish(document.slice(*wanted), args)
end

def issue_comments(document)
  Array(document["comments"]).map do |comment|
    {"author" => comment["author"], "body" => comment["body"], "createdAt" => comment["createdAt"]}
  end
end

def api(args)
  path = args.find { |arg| !arg.start_with?("-") }
  case path
  when %r{/pulls/\d+/comments\z}
    finish(JSON.parse(read_snapshot("review-comments.json")), args)
  when %r{/issues/\d+/comments\z}
    finish(issue_comments(JSON.parse(read_snapshot("pr.json"))), args)
  when %r{/issues/\d+/timeline\z}
    finish(JSON.parse(read_snapshot("timeline.json")), args)
  else
    warn %({"message":"Not Found","status":"404"})
    exit 1
  end
end

def help_text(name)
  lines = [
    "Work with GitHub issues and pull requests.",
    "",
    "USAGE",
    "  #{name} pr view <number|url> [--json FIELDS] [--jq EXPR]",
    "  #{name} pr diff <number|url>",
    "  #{name} pr checks <number|url>",
    "  #{name} issue view <number|url> [--json FIELDS] [--jq EXPR]",
    "  #{name} api repos/OWNER/REPO/pulls/N/comments"
  ]
  installed = snapshot?("view-md.md")
  lines << "  #{name} view-md <number|url> [--max-diff LINES]" if installed
  lines.concat(["", "A selector is a number or a full URL. `--json` takes a comma-separated field list."])
  lines << "`view-md` renders the whole issue or pull request, discussion and patch included." if installed
  lines.join("\n") + "\n"
end

def view_md(args)
  # A snapshot built without view-md records stands in for a machine without the extension.
  fail_with('unknown command "view-md" for "gh"') unless snapshot?("view-md.md")
  limit = begin
    index = args.index("--max-diff")
    index ? Integer(args[index + 1]) : 800
  rescue ArgumentError, TypeError
    800
  end
  emit(read_snapshot(limit <= 0 ? "view-md-trimmed.md" : "view-md.md"), ["view-md", *args])
end

args = ARGV.dup
# The fixture installs this file once and wraps it as `gh` and `gw`, so the wrapper names the word
# the help text should use.
name = args.first == "--as" ? args[1] : "gh"
args = args.drop(2) if args.first == "--as"

command = args.first
rest = args.drop(1)

case command
when "view-md" then view_md(rest)
when "pr"
  if rest.first.nil? || rest.include?("--help") || rest.include?("-h")
    emit(help_text(name), args)
    exit 0
  end
  case rest.first
  when "view" then json_view("pr.json", ["pr", "view", *rest.drop(1)])
  when "diff" then emit(read_snapshot("diff.patch"), ["pr", "diff", *rest.drop(1)])
  when "checks" then emit("no checks reported\n", ["pr", "checks"])
  else fail_with("unknown pr subcommand: #{rest.first}")
  end
when "issue"
  if rest.first.nil? || rest.include?("--help") || rest.include?("-h")
    emit(help_text(name), args)
    exit 0
  end
  case rest.first
  when "view" then json_view("issue.json", ["issue", "view", *rest.drop(1)])
  else fail_with("unknown issue subcommand: #{rest.first}")
  end
when "api" then api(rest)
when "extension"
  if snapshot?("view-md.md")
    emit("gh view-md\tjoshbeckman/gh-view-md\t1\n", ["extension", *rest])
  else
    emit("", rest)
  end
when "--help", "-h", nil
  emit(help_text(name), args)
else
  fail_with("unknown command: #{command}")
end
