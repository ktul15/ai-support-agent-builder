import 'package:flutter/material.dart';

import '../../data/chat_models.dart';
import 'citation_sheet.dart';

/// Tappable `[n]` source chips under a grounded answer — tap opens the source.
class CitationChips extends StatelessWidget {
  const CitationChips({super.key, required this.citations});

  final List<Citation> citations;

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(left: 12, right: 12, top: 2, bottom: 6),
      child: Wrap(
        spacing: 6,
        runSpacing: 4,
        children: [
          for (final c in citations)
            ActionChip(
              visualDensity: VisualDensity.compact,
              label: Text(_chipLabel(c)),
              onPressed: () => showCitationSheet(context, c),
            ),
        ],
      ),
    );
  }

  static String _chipLabel(Citation c) => c.title.isEmpty
      ? '[${c.marker}]'
      : '[${c.marker}] ${_shortTitle(c.title)}';

  // Truncate by grapheme cluster so a long title can't split an emoji/surrogate.
  static String _shortTitle(String title) {
    final chars = title.characters;
    return chars.length <= 28 ? title : '${chars.take(27)}…';
  }
}
