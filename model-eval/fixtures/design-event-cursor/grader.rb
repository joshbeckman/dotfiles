require "digest"
require "json"

workspace, answer_path = ARGV
answer = File.read(answer_path).downcase
checks = [
  {"name" => "opaque cursor request", "required" => true, "passed" => answer.include?("cursor") && answer.match?(/opaque|base64|token/)},
  {"name" => "stable id ordering", "required" => true, "passed" => answer.include?("id") && answer.match?(/monotonic|ascending|strict|stable/)},
  {"name" => "success has events and next cursor", "required" => true, "passed" => answer.include?("events") && answer.match?(/next[_ -]?cursor/)},
  {"name" => "invalid cursor error", "required" => true, "passed" => answer.include?("invalid") && answer.include?("400")},
  {"name" => "expired cursor error", "required" => true, "passed" => answer.include?("expired") && answer.match?(/410|gone/)},
  {"name" => "compatibility migration", "required" => true, "passed" => answer.include?("after_id") && answer.match?(/one release|deprecat|compatib/)},
  {"name" => "concise", "required" => false, "passed" => answer.split.length <= 300}
]
source = File.join(__dir__, "workspace", "README.md")
target = File.join(workspace, "README.md")
checks << {"name" => "workspace unchanged", "required" => true, "passed" => File.file?(target) && Digest::SHA256.file(source).hexdigest == Digest::SHA256.file(target).hexdigest}
puts JSON.generate("required_pass" => checks.all? { |check| !check["required"] || check["passed"] }, "checks" => checks)
