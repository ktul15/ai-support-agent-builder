import 'package:flutter/material.dart';

import '../../data/chat_models.dart';

/// Opens the anchored source behind a citation: title, page/section, and the
/// exact snippet that grounded the answer (invariant #6).
Future<void> showCitationSheet(BuildContext context, Citation citation) {
  return showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (context) => _CitationSheet(citation: citation),
  );
}

String _locationLabel(Citation c) {
  final parts = <String>[
    if (c.page != null) 'Page ${c.page}',
    if (c.section != null && c.section!.isNotEmpty) c.section!,
  ];
  return parts.isEmpty ? 'Source' : parts.join(' · ');
}

class _CitationSheet extends StatelessWidget {
  const _CitationSheet({required this.citation});

  final Citation citation;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    // Captured before any pop so the snackbar has a live messenger.
    final messenger = ScaffoldMessenger.of(context);
    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 4, 20, 16),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              citation.title.isEmpty
                  ? '[${citation.marker}]'
                  : '[${citation.marker}] ${citation.title}',
              style: theme.textTheme.titleMedium,
            ),
            const SizedBox(height: 4),
            Text(
              _locationLabel(citation),
              style: theme.textTheme.bodySmall?.copyWith(
                color: theme.colorScheme.onSurfaceVariant,
              ),
            ),
            const Divider(height: 20),
            Flexible(
              child: SingleChildScrollView(
                child: SelectableText(
                  citation.snippet,
                  style: theme.textTheme.bodyMedium?.copyWith(height: 1.4),
                ),
              ),
            ),
            const SizedBox(height: 16),
            Align(
              alignment: Alignment.centerRight,
              child: FilledButton.tonalIcon(
                onPressed: () {
                  Navigator.of(context).pop();
                  // No consumer document viewer yet (tracked as a follow-up);
                  // the sheet already shows the grounding snippet in full.
                  messenger
                    ..hideCurrentSnackBar()
                    ..showSnackBar(
                      const SnackBar(
                        content: Text('Full document view is coming soon.'),
                      ),
                    );
                },
                icon: const Icon(Icons.open_in_new),
                label: const Text('Open document'),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
