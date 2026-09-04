require "json"
require "open3"

workspace = ARGV.fetch(0)
script = <<~'PY'
  from ranges import merge_ranges
  source = [[5, 6], [1, 2], [3, 4], [10, 10]]
  before = [item[:] for item in source]
  assert merge_ranges(source) == [[1, 6], [10, 10]]
  assert source == before
  assert merge_ranges([]) == []
  try:
      merge_ranges([[4, 3]])
  except ValueError:
      pass
  else:
      raise AssertionError("invalid range accepted")
PY
_out, err, status = Open3.capture3("python3", "-c", script, chdir: workspace)
checks = [
  {"name" => "hidden behavior", "required" => true, "passed" => status.success?, "detail" => err.strip},
  {"name" => "allowed change scope", "required" => true, "passed" => Dir.children(workspace).all? { |name| ["ranges.py", "test_ranges.py", "__pycache__"].include?(name) }}
]
puts JSON.generate("required_pass" => checks.all? { |check| !check["required"] || check["passed"] }, "checks" => checks)
