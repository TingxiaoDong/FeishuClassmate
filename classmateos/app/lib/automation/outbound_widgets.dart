/// 自动化页面复用项目 Fs 设计令牌，不改变业务权限。
library;

import 'package:flutter/material.dart';
import '../theme.dart';

class OutboundSection extends StatelessWidget {
  final String title;
  final String? description;
  final List<Widget> children;
  const OutboundSection({
    super.key,
    required this.title,
    this.description,
    required this.children,
  });
  @override
  Widget build(BuildContext context) => Container(
    margin: const EdgeInsets.only(bottom: 16),
    padding: const EdgeInsets.all(20),
    decoration: BoxDecoration(
      color: Colors.white,
      border: Border.all(color: Fs.lineLight),
      borderRadius: BorderRadius.circular(8),
    ),
    child: Material(
      color: Colors.white,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            title,
            style: const TextStyle(
              fontSize: 16,
              fontWeight: FontWeight.w600,
              color: Fs.text1,
            ),
          ),
          if (description != null) ...[
            const SizedBox(height: 6),
            Text(
              description!,
              style: const TextStyle(
                fontSize: 13,
                color: Fs.text2,
                height: 1.5,
              ),
            ),
          ],
          const SizedBox(height: 16),
          ...children,
        ],
      ),
    ),
  );
}

class OutboundNotice extends StatelessWidget {
  final String text;
  final bool warning;
  const OutboundNotice(this.text, {super.key, this.warning = false});
  @override
  Widget build(BuildContext context) => Container(
    width: double.infinity,
    margin: const EdgeInsets.only(bottom: 12),
    padding: const EdgeInsets.all(12),
    decoration: BoxDecoration(
      color: warning ? Fs.orangeLight : Fs.primaryBg,
      borderRadius: BorderRadius.circular(6),
    ),
    child: Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(
          warning ? Icons.info_outline : Icons.shield_outlined,
          size: 18,
          color: warning ? Fs.orange : Fs.primary,
        ),
        const SizedBox(width: 8),
        Expanded(
          child: Text(
            text,
            style: const TextStyle(fontSize: 13, color: Fs.text2, height: 1.6),
          ),
        ),
      ],
    ),
  );
}

class OutboundBadge extends StatelessWidget {
  final String text;
  final Color color;
  const OutboundBadge(this.text, {super.key, this.color = Fs.primary});
  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
    decoration: BoxDecoration(
      color: color.withValues(alpha: .09),
      borderRadius: BorderRadius.circular(4),
    ),
    child: Text(
      text,
      style: TextStyle(fontSize: 12, color: color, fontWeight: FontWeight.w500),
    ),
  );
}

class OutboundEmpty extends StatelessWidget {
  final String title, description;
  const OutboundEmpty(this.title, this.description, {super.key});
  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.symmetric(vertical: 40, horizontal: 16),
    child: Center(
      child: Column(
        children: [
          const Icon(
            Icons.assignment_outlined,
            size: 40,
            color: Fs.textDisabled,
          ),
          const SizedBox(height: 16),
          Text(
            title,
            style: const TextStyle(fontSize: 15, fontWeight: FontWeight.w500),
          ),
          const SizedBox(height: 8),
          Text(
            description,
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 13, color: Fs.text3),
          ),
        ],
      ),
    ),
  );
}
