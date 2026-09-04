def merge_ranges(ranges):
    """Return sorted, merged inclusive ranges without mutating the input."""
    if not ranges:
        return []

    ordered = sorted(ranges)
    merged = [ordered[0]]
    for start, end in ordered[1:]:
        previous_start, previous_end = merged[-1]
        if start <= previous_end:
            merged[-1] = [previous_start, max(previous_end, end)]
        else:
            merged.append([start, end])
    return merged
