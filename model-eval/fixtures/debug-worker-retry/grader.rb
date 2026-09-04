require "digest"
require "json"

workspace, answer_path = ARGV
answer = File.read(answer_path).downcase
checks = []
checks << {"name" => "identifies ordering failure", "required" => true, "passed" => answer.include?("ledger") && answer.match?(/after|order|between|before/)}
checks << {"name" => "cites failed ledger write", "required" => true, "passed" => answer.include?("connection-reset") || answer.include?("connection reset")}
checks << {"name" => "cites retry evidence", "required" => true, "passed" => answer.include?("unacked") && answer.include?("missing")}
checks << {"name" => "rejects timeout", "required" => true, "passed" => answer.include?("timeout") && (answer.include?("5") || answer.include?("300"))}
checks << {"name" => "recommends durable idempotency or atomic ordering", "required" => true, "passed" => answer.match?(/idempoten|atomic|transaction|record.*before/)}
checks << {"name" => "concise", "required" => false, "passed" => answer.split.length <= 220}
original = File.join(__dir__, "workspace")
unchanged = Dir.glob(File.join(original, "*")).all? do |source|
  target = File.join(workspace, File.basename(source))
  File.file?(target) && Digest::SHA256.file(source).hexdigest == Digest::SHA256.file(target).hexdigest
end
checks << {"name" => "workspace unchanged", "required" => true, "passed" => unchanged}
puts JSON.generate("required_pass" => checks.all? { |check| !check["required"] || check["passed"] }, "checks" => checks)
