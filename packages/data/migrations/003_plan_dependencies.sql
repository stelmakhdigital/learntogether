-- The plan stores what a node rests on. The teacher asks «без чего этот узел не
-- держится», and the reverse list is derivable from that; holds_dependency_of_json
-- carried the inverse edge and nothing ever read it.

ALTER TABLE plan_node DROP COLUMN holds_dependency_of_json;
ALTER TABLE plan_node ADD COLUMN depends_on_json TEXT NOT NULL DEFAULT '[]';
