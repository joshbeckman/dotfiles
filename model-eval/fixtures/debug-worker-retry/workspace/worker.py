def deliver(job, queue, notifier, ledger):
    notifier.send(job.message)
    queue.ack(job.id)
    ledger.record(job.id, "delivered")


def recover(queue, ledger):
    for job in queue.unacked():
        if not ledger.contains(job.id):
            queue.retry(job.id)
