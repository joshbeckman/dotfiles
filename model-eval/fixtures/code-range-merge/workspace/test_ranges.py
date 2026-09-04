import unittest
from ranges import merge_ranges


class MergeRangesTest(unittest.TestCase):
    def test_overlap(self):
        self.assertEqual([[1, 5]], merge_ranges([[3, 5], [1, 4]]))

    def test_disjoint_ranges_are_sorted(self):
        self.assertEqual([[1, 2], [7, 9]], merge_ranges([[7, 9], [1, 2]]))


if __name__ == "__main__":
    unittest.main()
