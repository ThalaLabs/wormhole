package aptos

import (
	"context"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"io/ioutil"
	"net/http"
	"time"

	"github.com/certusone/wormhole/node/pkg/common"
	"github.com/certusone/wormhole/node/pkg/p2p"
	gossipv1 "github.com/certusone/wormhole/node/pkg/proto/gossip/v1"
	"github.com/certusone/wormhole/node/pkg/readiness"
	"github.com/certusone/wormhole/node/pkg/supervisor"
	"github.com/certusone/wormhole/node/pkg/vaa"
	eth_common "github.com/ethereum/go-ethereum/common"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
	"github.com/tidwall/gjson"
	"go.uber.org/zap"
)

type (
	// Watcher is responsible for looking over Aptos blockchain and reporting new transactions to the wormhole contract
	Watcher struct {
		aptosRPC     string
		aptosAccount string
		aptosHandle  string
		aptosQuery   string
		aptosHealth  string

		msgChan  chan *common.MessagePublication
		obsvReqC chan *gossipv1.ObservationRequest

		next_sequence uint64 // aptos native sequence number for wormhole contract
	}
)

var (
	aptosMessagesConfirmed = promauto.NewCounter(
		prometheus.CounterOpts{
			Name: "wormhole_aptos_observations_confirmed_total",
			Help: "Total number of verified Aptos observations found",
		})
	currentAptosHeight = promauto.NewGauge(
		prometheus.GaugeOpts{
			Name: "wormhole_aptos_current_height",
			Help: "Current Aptos block height",
		})
)

// NewWatcher creates a new Aptos appid watcher
func NewWatcher(
	aptosRPC string,
	aptosAccount string,
	aptosHandle string,
	lockEvents chan *common.MessagePublication,
	obsvReqC chan *gossipv1.ObservationRequest,
) *Watcher {
	return &Watcher{
		aptosRPC:      aptosRPC,
		aptosAccount:  aptosAccount,
		aptosHandle:   aptosHandle,
		aptosQuery:    "",
		aptosHealth:   "",
		msgChan:       lockEvents,
		obsvReqC:      obsvReqC,
		next_sequence: 0,
	}
}

func (e *Watcher) retrievePayload(s string) ([]byte, error) {
	res, err := http.Get(s) // nolint
	if err != nil {
		return nil, err
	}
	body, err := ioutil.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	return body, err
}

func (e *Watcher) observeData(logger *zap.Logger, data gjson.Result, native_seq uint64) {
	em := data.Get("sender")
	if !em.Exists() {
		logger.Info("sender")
		return
	}

	// We read the emitter address as a 64 bit unsigned integer.
	// .Uint() will happily return 0 if the input string is not a valid u64.
	// We absolutely want to make sure that we only get a 0 when the input
	// string was "0", and not swallow an error silently.
	// The emitter address in the contract is represented as a u128, so there's
	// a chance of overflow (though it will take a while to get there, as the
	// emitter addresses are handed out incrementally -- TODO: we might want to
	// consider changing that to u64 instead, which will require a testnet
	// redeploy at a different address).
	em_string := em.String()
	em_uint := em.Uint()
	if (em_string != "0" && em_uint == 0) {
		logger.Error("Invalid emitter", zap.String("emitter string", em_string))
		return
	}

	emitter := make([]byte, 8)
	binary.BigEndian.PutUint64(emitter, em.Uint())

	var a vaa.Address
	copy(a[24:], emitter)

	id := make([]byte, 8)
	binary.BigEndian.PutUint64(id, native_seq)

	var txHash = eth_common.BytesToHash(id) // 32 bytes = d3b136a6a182a40554b2fafbc8d12a7a22737c10c81e33b33d1dcb74c532708b

	v := data.Get("payload")
	if !v.Exists() {
		logger.Info("payload")
		return
	}

	pl, err := hex.DecodeString(v.String()[2:])
	if err != nil {
		logger.Info("payload decode")
		return
	}

	ts := data.Get("timestamp")
	if !ts.Exists() {
		logger.Info("timestamp")
		return
	}

	nonce := data.Get("nonce")
	if !nonce.Exists() {
		logger.Info("nonce")
		return
	}

	sequence := data.Get("sequence")
	if !sequence.Exists() {
		logger.Info("sequence")
		return
	}

	consistency_level := data.Get("consistency_level")
	if !consistency_level.Exists() {
		logger.Info("consistency_level")
		return
	}

	observation := &common.MessagePublication{
		TxHash:           txHash,
		Timestamp:        time.Unix(int64(ts.Uint()), 0),
		Nonce:            uint32(nonce.Uint()), // uint32
		Sequence:         sequence.Uint(),
		EmitterChain:     vaa.ChainIDAptos,
		EmitterAddress:   a,
		Payload:          pl,
		ConsistencyLevel: uint8(consistency_level.Uint()),
	}

	aptosMessagesConfirmed.Inc()

	logger.Info("message observed",
		zap.Stringer("txHash", observation.TxHash),
		zap.Time("timestamp", observation.Timestamp),
		zap.Uint32("nonce", observation.Nonce),
		zap.Uint64("sequence", observation.Sequence),
		zap.Stringer("emitter_chain", observation.EmitterChain),
		zap.Stringer("emitter_address", observation.EmitterAddress),
		zap.Binary("payload", observation.Payload),
		zap.Uint8("consistency_level", observation.ConsistencyLevel),
	)

	e.msgChan <- observation
}

func (e *Watcher) Run(ctx context.Context) error {
	p2p.DefaultRegistry.SetNetworkStats(vaa.ChainIDAptos, &gossipv1.Heartbeat_Network{
		ContractAddress: e.aptosAccount,
	})

	logger := supervisor.Logger(ctx)
	errC := make(chan error)

	logger.Info("Aptos watcher connecting to RPC node ", zap.String("url", e.aptosRPC))

	e.aptosQuery = fmt.Sprintf(`%s/v1/accounts/%s/events/%s/event`, e.aptosRPC, e.aptosAccount, e.aptosHandle)
	e.aptosHealth = fmt.Sprintf(`%s/v1`, e.aptosRPC)

	go func() {
		timer := time.NewTicker(time.Second * 1)
		defer timer.Stop()

		for {
			select {
			case <-ctx.Done():
				return
			case r := <-e.obsvReqC:
				if vaa.ChainID(r.ChainId) != vaa.ChainIDAptos {
					panic("invalid chain ID")
				}

				native_seq := binary.BigEndian.Uint64(r.TxHash)

				logger.Info("Received obsv request", zap.Uint64("tx_hash", native_seq))

				s := fmt.Sprintf(`%s?start=%d&limit=1`, e.aptosQuery, native_seq)

				body, err := e.retrievePayload(s)
				if err != nil {
					logger.Error("retrievePayload", zap.Error(err))
					p2p.DefaultRegistry.AddErrorCount(vaa.ChainIDAptos, 1)
					errC <- err
					break
				}

				if !gjson.Valid(string(body)) {
					logger.Error("InvalidJson: " + string(body))
					p2p.DefaultRegistry.AddErrorCount(vaa.ChainIDAptos, 1)
					break

				}

				outcomes := gjson.ParseBytes(body)

				for _, chunk := range outcomes.Array() {
					newSeq := chunk.Get("sequence_number")
					if !newSeq.Exists() {
						break
					}

					if newSeq.Uint() != native_seq {
						logger.Error("newSeq != native_seq")
						break

					}

					data := chunk.Get("data")
					if !data.Exists() {
						break
					}
					e.observeData(logger, data, native_seq)
				}

			case <-timer.C:
				s := ""
				if e.next_sequence == 0 {
					s = fmt.Sprintf(`%s?limit=1`, e.aptosQuery)
				} else {
					s = fmt.Sprintf(`%s?start=%d`, e.aptosQuery, e.next_sequence)
				}

				body, err := e.retrievePayload(s)
				if err != nil {
					logger.Error("retrievePayload", zap.Error(err))
					p2p.DefaultRegistry.AddErrorCount(vaa.ChainIDAptos, 1)
					errC <- err
					break
				}

				// data doesn't exist yet. skip, and try again later
				if string(body) == "" {
					continue
				}

				if !gjson.Valid(string(body)) {
					logger.Error("InvalidJson: " + string(body))
					p2p.DefaultRegistry.AddErrorCount(vaa.ChainIDAptos, 1)
					break

				}

				outcomes := gjson.ParseBytes(body)

				for _, chunk := range outcomes.Array() {
					native_seq := chunk.Get("sequence_number")
					if !native_seq.Exists() {
						continue
					}
					if e.next_sequence == 0 {
						e.next_sequence = native_seq.Uint() + 1
						break
					} else {
						e.next_sequence = native_seq.Uint() + 1
					}

					data := chunk.Get("data")
					if !data.Exists() {
						continue
					}
					e.observeData(logger, data, native_seq.Uint())
				}

				health, err := e.retrievePayload(e.aptosHealth)
				if err != nil {
					logger.Error("health", zap.Error(err))
					p2p.DefaultRegistry.AddErrorCount(vaa.ChainIDAptos, 1)
					errC <- err
					break
				}

				if !gjson.Valid(string(health)) {
					logger.Error("Invalid JSON in health response: " + string(health))
					p2p.DefaultRegistry.AddErrorCount(vaa.ChainIDAptos, 1)
					continue

				}

				logger.Info(string(health) + string(body))

				phealth := gjson.ParseBytes(health)

				block_height := phealth.Get("block_height")

				if block_height.Exists() {
					currentAptosHeight.Set(float64(block_height.Uint()))
					p2p.DefaultRegistry.SetNetworkStats(vaa.ChainIDAptos, &gossipv1.Heartbeat_Network{
						Height:          int64(block_height.Uint()),
						ContractAddress: e.aptosAccount,
					})

					readiness.SetReady(common.ReadinessAptosSyncing)
				}
			}
		}
	}()

	select {
	case <-ctx.Done():
		return ctx.Err()
	case err := <-errC:
		return err
	}
}
